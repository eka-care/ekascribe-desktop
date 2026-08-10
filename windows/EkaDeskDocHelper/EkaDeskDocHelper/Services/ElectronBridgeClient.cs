using System;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace EkaDeskDocHelper.Services;

internal sealed class ElectronBridgeClient : IElectronBridgeClient
{
    private readonly string? _host;
    private readonly int _port;
    private readonly TimeSpan _pingInterval;
    private readonly TimeSpan _pongTimeout;
    private readonly bool _isStdio;
    private readonly Stream? _stdioInput;
    private readonly Stream? _stdioOutput;

    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement?>> _pendingRequests = new();
    private readonly object _stateLock = new();

    private TcpClient? _client;
    private Stream? _readStream;
    private Stream? _writeStream;
    private CancellationTokenSource? _runCts;
    private Task? _runTask;
    private Task? _pingTask;

    private volatile bool _isConnected;
    private long _lastPongUnixMs;
    private static readonly TimeSpan SendWriteTimeout = TimeSpan.FromSeconds(3);

    public event EventHandler<BridgeConnectionStateChangedEventArgs>? ConnectionStateChanged;
    public event EventHandler<BridgeEventReceivedEventArgs>? EventReceived;

    public Func<string, JsonElement?, Task<object?>>? RequestHandler { get; set; }

    public bool IsConnected => _isConnected;
    public bool IsStdioTransport => _isStdio;

    public ElectronBridgeClient(
        string host,
        int port,
        TimeSpan? pingInterval = null,
        TimeSpan? pongTimeout = null)
    {
        _host = host;
        _port = port;
        _pingInterval = pingInterval ?? TimeSpan.FromSeconds(5);
        _pongTimeout = pongTimeout ?? TimeSpan.FromSeconds(15);
        _isStdio = false;
    }

    /// <summary>
    /// Stdio transport: read framed messages from <paramref name="input"/>
    /// (Electron's stdout-side pipe) and write to <paramref name="output"/>
    /// (Electron's stdin-side pipe). Liveness pings are disabled in this mode
    /// because the parent process owns the helper's lifecycle.
    /// </summary>
    public ElectronBridgeClient(
        Stream input,
        Stream output)
    {
        _stdioInput = input ?? throw new ArgumentNullException(nameof(input));
        _stdioOutput = output ?? throw new ArgumentNullException(nameof(output));
        _pingInterval = TimeSpan.Zero;
        _pongTimeout = TimeSpan.Zero;
        _isStdio = true;
        _port = 0;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        lock (_stateLock)
        {
            if (_runTask != null) return Task.CompletedTask;
            _runCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _runTask = Task.Run(() => RunAsync(_runCts.Token));
            // Stdio transport relies on parent process aliveness; pinging is
            // unnecessary and would also pollute the framed channel.
            _pingTask = _isStdio
                ? Task.CompletedTask
                : Task.Run(() => PingLoopAsync(_runCts.Token));
        }
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        CancellationTokenSource? cts;
        Task? run;
        Task? ping;

        lock (_stateLock)
        {
            cts = _runCts;
            _runCts = null;
            run = _runTask;
            _runTask = null;
            ping = _pingTask;
            _pingTask = null;
        }

        if (cts != null)
        {
            try { cts.Cancel(); } catch { /* best-effort */ }
            cts.Dispose();
        }

        await CloseConnectionAsync("stop").ConfigureAwait(false);

        if (run != null) await WaitBestEffortAsync(run, cancellationToken).ConfigureAwait(false);
        if (ping != null) await WaitBestEffortAsync(ping, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(CancellationToken.None).ConfigureAwait(false);
        _sendLock.Dispose();
    }

    public async Task SendEventAsync(string eventName, object? payload, CancellationToken cancellationToken)
    {
        var stream = await WaitForConnectedStreamAsync(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
        if (stream == null)
        {
            Console.Error.WriteLine($"[ElectronBridgeClient] send event failed (disconnected): {eventName}");
            throw new InvalidOperationException("Not connected to Electron bridge.");
        }

        var msg = new
        {
            v = 1,
            id = Guid.NewGuid().ToString(),
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            kind = "event",
            name = eventName,
            payload,
        };
        Console.Error.WriteLine($"[ElectronBridgeClient] -> event {eventName} payload={SafeSerialize(payload)}");

        var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg, _jsonOptions));
        var frame = new byte[4 + json.Length];
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(0, 4), (uint)json.Length);
        Buffer.BlockCopy(json, 0, frame, 4, json.Length);

        await WriteFrameWithTimeoutAsync(stream, frame, cancellationToken, $"event:{eventName}").ConfigureAwait(false);
        Console.Error.WriteLine($"[ElectronBridgeClient] <- send event ok {eventName}");
    }

    public async Task<JsonElement?> SendRequestAsync(string name, object? payload, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var stream = _writeStream;
        if (stream == null) throw new InvalidOperationException("Not connected to Electron bridge.");

        var id = Guid.NewGuid().ToString();
        var tcs = new TaskCompletionSource<JsonElement?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pendingRequests[id] = tcs;

        try
        {
            var msg = new
            {
                v = 1,
                id,
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                kind = "request",
                name,
                payload,
            };

            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg, _jsonOptions));
            var frame = new byte[4 + json.Length];
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(0, 4), (uint)json.Length);
            Buffer.BlockCopy(json, 0, frame, 4, json.Length);

            await WriteFrameWithTimeoutAsync(stream, frame, cancellationToken, $"request:{name}").ConfigureAwait(false);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(timeout);
            using var reg = timeoutCts.Token.Register(() => tcs.TrySetCanceled());
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            _pendingRequests.TryRemove(id, out _);
        }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        if (_isStdio)
        {
            // Stdio session is single-shot: when stdin closes, the parent has
            // gone away and the helper should exit. No reconnect.
            try
            {
                AttachStdioStreams();
                await ReceiveLoopAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // shutting down
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ElectronBridgeClient] stdio receive loop ended: {ex.Message}");
            }
            finally
            {
                await CloseConnectionAsync("stdio-eof").ConfigureAwait(false);
            }
            return;
        }

        var attempt = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await ConnectOnceAsync(cancellationToken).ConfigureAwait(false);
                attempt = 0;
                await ReceiveLoopAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                await CloseConnectionAsync(ex.Message).ConfigureAwait(false);
            }

            // Backoff before reconnect
            attempt++;
            var delay = ComputeBackoffDelay(attempt);
            try
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private void AttachStdioStreams()
    {
        lock (_stateLock)
        {
            _readStream = _stdioInput;
            _writeStream = _stdioOutput;
            _isConnected = true;
            _lastPongUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        ConnectionStateChanged?.Invoke(this, new BridgeConnectionStateChangedEventArgs(true));
    }

    private async Task ConnectOnceAsync(CancellationToken cancellationToken)
    {
        var client = new TcpClient
        {
            NoDelay = true,
        };

        using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        connectCts.CancelAfter(TimeSpan.FromSeconds(3));

        await client.ConnectAsync(_host!, _port, connectCts.Token).ConfigureAwait(false);
        var stream = client.GetStream();

        lock (_stateLock)
        {
            _client = client;
            _readStream = stream;
            _writeStream = stream;
            _isConnected = true;
            _lastPongUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        ConnectionStateChanged?.Invoke(this, new BridgeConnectionStateChangedEventArgs(true));
    }

    private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var stream = _readStream;
            if (stream == null) throw new IOException("Stream unavailable");

            var header = await ReadExactAsync(stream, 4, cancellationToken).ConfigureAwait(false);
            var len = BinaryPrimitives.ReadUInt32BigEndian(header);
            if (len == 0 || len > 16 * 1024 * 1024) throw new InvalidDataException($"Bad frame length: {len}");

            var jsonBytes = await ReadExactAsync(stream, (int)len, cancellationToken).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(jsonBytes);

            if (!TryHandleMessage(doc.RootElement)) continue;
        }
    }

    private bool TryHandleMessage(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        if (!root.TryGetProperty("v", out var v) || v.GetInt32() != 1) return false;
        if (!root.TryGetProperty("kind", out var kindEl) || kindEl.ValueKind != JsonValueKind.String) return false;

        var kind = kindEl.GetString();
        switch (kind)
        {
            case "event":
            {
                if (!root.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String) return false;
                var name = nameEl.GetString() ?? string.Empty;
                JsonElement? payload = null;
                if (root.TryGetProperty("payload", out var payloadEl))
                {
                    payload = payloadEl.Clone();
                }
                Console.Error.WriteLine($"[ElectronBridgeClient] <- event {name} payload={SafeSerialize(payload)}");
                EventReceived?.Invoke(this, new BridgeEventReceivedEventArgs(name, payload));
                return true;
            }
            case "ping":
                _ = SendPongBestEffort();
                return true;
            case "pong":
                Interlocked.Exchange(ref _lastPongUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                return true;
            case "request":
            {
                if (!root.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String) return false;
                if (!root.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String) return false;
                var requestId = idEl.GetString() ?? string.Empty;
                var requestName = nameEl.GetString() ?? string.Empty;
                JsonElement? requestPayload = root.TryGetProperty("payload", out var reqPayloadEl) ? reqPayloadEl.Clone() : null;
                Console.Error.WriteLine($"[ElectronBridgeClient] <- request {requestName} payload={SafeSerialize(requestPayload)}");
                _ = Task.Run(() => HandleIncomingRequestAsync(requestId, requestName, requestPayload));
                return true;
            }
            case "response":
            {
                if (!root.TryGetProperty("replyTo", out var replyToEl) || replyToEl.ValueKind != JsonValueKind.String)
                    return false;
                var replyTo = replyToEl.GetString();
                if (replyTo != null && _pendingRequests.TryRemove(replyTo, out var tcs))
                {
                    if (root.TryGetProperty("ok", out var okEl) && okEl.GetBoolean())
                    {
                        JsonElement? responsePayload = root.TryGetProperty("payload", out var p) ? p.Clone() : null;
                        tcs.TrySetResult(responsePayload);
                    }
                    else
                    {
                        var errorMsg = "Bridge request failed";
                        if (root.TryGetProperty("error", out var errEl) &&
                            errEl.TryGetProperty("message", out var msgEl) &&
                            msgEl.ValueKind == JsonValueKind.String)
                        {
                            errorMsg = msgEl.GetString() ?? errorMsg;
                        }
                        tcs.TrySetException(new InvalidOperationException(errorMsg));
                    }
                }
                return true;
            }
            default:
                return false;
        }
    }

    private async Task HandleIncomingRequestAsync(string requestId, string requestName, JsonElement? payload)
    {
        var handler = RequestHandler;
        if (handler == null)
        {
            await SendResponseAsync(requestId, ok: false, payload: null,
                errorCode: "REQUEST_UNHANDLED",
                errorMessage: $"No handler registered for request: {requestName}")
                .ConfigureAwait(false);
            return;
        }

        try
        {
            var result = await handler(requestName, payload).ConfigureAwait(false);
            await SendResponseAsync(requestId, ok: true, payload: result, errorCode: null, errorMessage: null)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ElectronBridgeClient] request handler for {requestName} threw: {ex.Message}");
            await SendResponseAsync(requestId, ok: false, payload: null,
                errorCode: "REQUEST_HANDLER_FAILED",
                errorMessage: ex.Message)
                .ConfigureAwait(false);
        }
    }

    private async Task SendResponseAsync(
        string replyTo,
        bool ok,
        object? payload,
        string? errorCode,
        string? errorMessage)
    {
        var stream = _writeStream;
        if (stream == null)
        {
            Console.Error.WriteLine($"[ElectronBridgeClient] drop response (disconnected) replyTo={replyTo}");
            return;
        }

        object msg = ok
            ? new
            {
                v = 1,
                id = Guid.NewGuid().ToString(),
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                kind = "response",
                replyTo,
                ok = true,
                payload,
            }
            : new
            {
                v = 1,
                id = Guid.NewGuid().ToString(),
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                kind = "response",
                replyTo,
                ok = false,
                error = new
                {
                    code = errorCode ?? "UNKNOWN",
                    message = errorMessage ?? "Request failed",
                },
            };

        try
        {
            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg, _jsonOptions));
            var frame = new byte[4 + json.Length];
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(0, 4), (uint)json.Length);
            Buffer.BlockCopy(json, 0, frame, 4, json.Length);
            await WriteFrameWithTimeoutAsync(stream, frame, CancellationToken.None, $"response:{replyTo}").ConfigureAwait(false);
            Console.Error.WriteLine($"[ElectronBridgeClient] -> response replyTo={replyTo} ok={ok}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ElectronBridgeClient] failed to send response replyTo={replyTo}: {ex.Message}");
        }
    }

    private async Task SendPingAsync(CancellationToken cancellationToken)
    {
        var stream = _writeStream;
        if (stream == null) return;

        var msg = new
        {
            v = 1,
            id = Guid.NewGuid().ToString(),
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            kind = "ping",
        };

        var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg, _jsonOptions));
        var frame = new byte[4 + json.Length];
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(0, 4), (uint)json.Length);
        Buffer.BlockCopy(json, 0, frame, 4, json.Length);

        try
        {
            await WriteFrameWithTimeoutAsync(stream, frame, cancellationToken, "ping").ConfigureAwait(false);
        }
        catch
        {
            // if sending ping fails, receive loop/reconnect will recover
        }
    }

    private async Task SendPongBestEffort()
    {
        try
        {
            var stream = _writeStream;
            if (stream == null) return;
            var msg = new
            {
                v = 1,
                id = Guid.NewGuid().ToString(),
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                kind = "pong",
            };

            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg, _jsonOptions));
            var frame = new byte[4 + json.Length];
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(0, 4), (uint)json.Length);
            Buffer.BlockCopy(json, 0, frame, 4, json.Length);

            await WriteFrameWithTimeoutAsync(stream, frame, CancellationToken.None, "pong").ConfigureAwait(false);
        }
        catch
        {
            // best-effort
        }
    }

    private async Task PingLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_pingInterval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }

            if (!_isConnected) continue;

            try
            {
                await SendPingAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                // if sending fails, receive loop will reconnect; keep this loop alive.
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var lastPong = Interlocked.Read(ref _lastPongUnixMs);
            if (now - lastPong > (long)_pongTimeout.TotalMilliseconds)
            {
                await CloseConnectionAsync("pong-timeout").ConfigureAwait(false);
            }
        }
    }

    private async Task CloseConnectionAsync(string? reason)
    {
        TcpClient? client;
        Stream? readStream;
        Stream? writeStream;
        var wasConnected = _isConnected;
        var wasStdio = _isStdio;

        lock (_stateLock)
        {
            client = _client;
            readStream = _readStream;
            writeStream = _writeStream;
            _client = null;
            _readStream = null;
            _writeStream = null;
            _isConnected = false;
        }

        foreach (var kvp in _pendingRequests)
        {
            if (_pendingRequests.TryRemove(kvp.Key, out var tcs))
                tcs.TrySetCanceled();
        }

        // For TCP, the streams are owned here. For stdio they're owned by the
        // process; closing them would tear down the parent pipe early.
        if (!wasStdio)
        {
            try { readStream?.Close(); } catch { /* best-effort */ }
            if (!ReferenceEquals(readStream, writeStream))
            {
                try { writeStream?.Close(); } catch { /* best-effort */ }
            }
            try { client?.Close(); } catch { /* best-effort */ }
        }

        if (wasConnected)
        {
            ConnectionStateChanged?.Invoke(this, new BridgeConnectionStateChangedEventArgs(false, reason));
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static TimeSpan ComputeBackoffDelay(int attempt)
    {
        var baseMs = 250;
        var maxMs = 5000;
        var delay = Math.Min(maxMs, baseMs * (int)Math.Pow(2, Math.Min(attempt, 6)));
        return TimeSpan.FromMilliseconds(delay);
    }

    private static async Task<byte[]> ReadExactAsync(Stream stream, int length, CancellationToken cancellationToken)
    {
        var buffer = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, length - offset), cancellationToken).ConfigureAwait(false);
            if (read <= 0) throw new EndOfStreamException("Stream closed");
            offset += read;
        }
        return buffer;
    }

    private static async Task WaitBestEffortAsync(Task task, CancellationToken cancellationToken)
    {
        try { await task.WaitAsync(cancellationToken).ConfigureAwait(false); } catch { /* best-effort */ }
    }

    private async Task WriteFrameWithTimeoutAsync(
        Stream stream,
        byte[] frame,
        CancellationToken callerToken,
        string operationName)
    {
        using var writeCts = CancellationTokenSource.CreateLinkedTokenSource(callerToken);
        writeCts.CancelAfter(SendWriteTimeout);
        var token = writeCts.Token;

        try
        {
            await _sendLock.WaitAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException ex)
        {
            await CloseConnectionAsync($"send-lock-timeout:{operationName}").ConfigureAwait(false);
            throw new TimeoutException($"Timed out waiting for send lock ({operationName}).", ex);
        }

        try
        {
            await stream.WriteAsync(frame, token).ConfigureAwait(false);
            await stream.FlushAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException ex)
        {
            await CloseConnectionAsync($"send-timeout:{operationName}").ConfigureAwait(false);
            throw new TimeoutException($"Timed out sending frame ({operationName}).", ex);
        }
        catch
        {
            await CloseConnectionAsync($"send-failed:{operationName}").ConfigureAwait(false);
            throw;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task<Stream?> WaitForConnectedStreamAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var startedAt = DateTime.UtcNow;
        while (!cancellationToken.IsCancellationRequested)
        {
            var stream = _writeStream;
            if (stream != null && _isConnected) return stream;

            if (DateTime.UtcNow - startedAt >= timeout) return null;
            await Task.Delay(75, cancellationToken).ConfigureAwait(false);
        }
        return null;
    }

    private string SafeSerialize(object? payload)
    {
        if (payload == null) return "null";
        try
        {
            return JsonSerializer.Serialize(payload, _jsonOptions);
        }
        catch
        {
            return payload.ToString() ?? "<unserializable>";
        }
    }
}

