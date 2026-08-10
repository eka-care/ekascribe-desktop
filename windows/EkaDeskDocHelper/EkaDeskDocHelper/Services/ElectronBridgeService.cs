using System.IO;
using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace EkaDeskDocHelper.Services;

internal sealed class ElectronBridgeService : IAsyncDisposable
{
    public static ElectronBridgeService Instance { get; } = new();

    private IElectronBridgeClient? _client;
    private IOverlayStateStore? _overlayStateStore;
    private OverlayWindowController? _overlayWindowController;
    private CancellationTokenSource? _cts;
    private const int ProcessingTimeoutSeconds = 120; // 2 minutes
    private int _bridgeReconnectInProgress;
    private ScribePhase _scribePhase = ScribePhase.Idle;
    private bool _isElectronFocused = false;
    private string? _currentSessionId;
    private Timer? _processingTimer;

    private ElectronBridgeService()
    {
    }

    public IElectronBridgeClient? Client => _client;

    public void Initialize(
        string host,
        int port,
        IOverlayStateStore overlayStateStore,
        Func<string, JsonElement?, Task<object?>> requestHandler)
    {
        InitializeInternal(
            new ElectronBridgeClient(
                host: host,
                port: port,
                pingInterval: TimeSpan.FromSeconds(5),
                pongTimeout: TimeSpan.FromSeconds(45)),
            overlayStateStore,
            requestHandler);
    }

    public void InitializeStdio(
        Stream input,
        Stream output,
        IOverlayStateStore overlayStateStore,
        Func<string, JsonElement?, Task<object?>> requestHandler)
    {
        InitializeInternal(
            new ElectronBridgeClient(input, output),
            overlayStateStore,
            requestHandler);
    }

    private void InitializeInternal(
        ElectronBridgeClient client,
        IOverlayStateStore overlayStateStore,
        Func<string, JsonElement?, Task<object?>> requestHandler)
    {
        _overlayStateStore = overlayStateStore;
        _cts = new CancellationTokenSource();

        _client = client;
        _client.ConnectionStateChanged += (_, args) =>
            Console.Error.WriteLine($"Electron bridge connected={args.IsConnected} reason={args.Reason}");
        _client.RequestHandler = requestHandler;
        _client.EventReceived += OnEventReceived;
    }

    public void AttachOverlayController(OverlayWindowController overlayWindowController)
    {
        _overlayWindowController = overlayWindowController;
    }

    /// <summary>
    /// Called when the user manually closes the processing overlay (X button).
    /// Resets the scribe phase to Idle so the overlay does not re-appear on the
    /// next RefreshOverlayVisibility() call while processing is still in flight.
    /// Mirrors macOS BridgeAppState.dismissOverlayPrompt() handling of .processing.
    /// </summary>
    public void DismissProcessingOverlay()
    {
        if (_scribePhase == ScribePhase.Processing)
        {
            _scribePhase = ScribePhase.Idle;
            RefreshOverlayVisibility();
        }
    }

    public Task StartAsync()
    {
        if (_client == null || _cts == null)
        {
            return Task.CompletedTask;
        }

        return _client.StartAsync(_cts.Token);
    }

    public async Task StopAsync()
    {
        if (_cts != null)
        {
            try { _cts.Cancel(); } catch { }
        }

        if (_client != null)
        {
            _client.EventReceived -= OnEventReceived;
            await _client.StopAsync(CancellationToken.None);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        if (_client != null)
        {
            await _client.DisposeAsync();
            _client = null;
        }

        _cts?.Dispose();
        _cts = null;
    }

    private void OnEventReceived(object? sender, BridgeEventReceivedEventArgs args)
    {
        Console.WriteLine($"Electron bridge event={args.EventName} payload={args.Payload}");

        if (args.EventName == "bridge.reconnect")
        {
            // Under stdio transport the parent owns the helper lifecycle; a
            // reconnect is meaningless because there is no socket to redial.
            if (_client is { IsStdioTransport: true })
            {
                Console.Error.WriteLine("[Bridge] ignoring bridge.reconnect over stdio transport");
                return;
            }
            _ = RestartBridgeConnectionAsync("electron-requested");
            return;
        }

        if (args.EventName == "scribe.status" && args.Payload.HasValue)
        {
            HandleScribeStatus(args.Payload.Value);
            return;
        }

        if (args.EventName == "overlay.state.changed" && args.Payload.HasValue)
        {
            HandleOverlayStateCommand(args.Payload.Value);
            return;
        }

        if (args.EventName == "overlay.prompt.show")
        {
            _overlayStateStore?.Set(OverlayUiState.Prompt, source: "electron");
            return;
        }

        if (args.EventName == "overlay.hide")
        {
            _overlayStateStore?.Set(null, source: "electron");
            return;
        }

        if (args.EventName == "scribe.processing.completed" && args.Payload.HasValue)
        {
            HandleScribeProcessingCompleted(args.Payload.Value);
            return;
        }

        if (args.EventName == "app.focus.changed" && args.Payload.HasValue)
        {
            HandleAppFocusChanged(args.Payload.Value);
            return;
        }

        if (args.EventName == "scribe.session.discarded")
        {
            _overlayStateStore?.Set(null, source: "electron");
            return;
        }

        if (args.EventName == "scribe.error" && args.Payload.HasValue)
        {
            HandleScribeError(args.Payload.Value);
            return;
        }
    }

    private void HandleOverlayStateCommand(JsonElement payload)
    {
        try
        {
            var normalizedState = payload.GetProperty("state").GetString()?.Trim().ToLowerInvariant();
            OverlayUiState? next = normalizedState switch
            {
                "prompt" => OverlayUiState.Prompt,
                "recording" => OverlayUiState.Recording,
                "processing" => OverlayUiState.Processing,
                "processed" => OverlayUiState.Processed,
                "none" or "hidden" => null,
                _ => null,
            };

            _overlayStateStore?.Set(next, source: "electron");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge->Overlay] malformed overlay.state.changed payload: {ex.Message}");
        }
    }

    private void HandleScribeStatus(JsonElement payload)
    {
        try
        {
            var processingStatus = payload.GetProperty("processingStatus").GetString();
            var normalized = NormalizeStatus(processingStatus);
            if (payload.TryGetProperty("sessionId", out var sidElem))
            {
                var sid = sidElem.GetString();
                if (!string.IsNullOrWhiteSpace(sid))
                    _currentSessionId = sid;
            }

            // Mirror macOS BridgeAppState.handleBridgeEvent("scribe.status"): set the
            // phase, then always re-drive overlay visibility through the single
            // focus-gated path (RefreshOverlayVisibility). Never set the store
            // directly here — doing so used to bypass the focus gate, which is why
            // Recording/Processing showed while Completed (focus-gated) did not.
            switch (normalized)
            {
                case ScribeStatusKind.Recording:
                    _scribePhase = ScribePhase.Recording;
                    _overlayWindowController?.DispatchSetRecordingPaused(false);
                    RefreshOverlayVisibility();
                    break;
                case ScribeStatusKind.Paused:
                    _scribePhase = ScribePhase.Paused;
                    _overlayWindowController?.DispatchSetRecordingPaused(true);
                    RefreshOverlayVisibility();
                    break;
                case ScribeStatusKind.Analyzing:
                case ScribeStatusKind.Initializing:
                    _scribePhase = ScribePhase.Processing;
                    RefreshOverlayVisibility();
                    break;
                case ScribeStatusKind.AnalyzingFailed:
                    SetTerminalPhase(ScribePhase.Error, errorMessage: null, transactionId: null);
                    break;
                case ScribeStatusKind.OutputGenerated:
                    SetTerminalPhase(ScribePhase.Completed, errorMessage: null, transactionId: null);
                    break;
                case ScribeStatusKind.NotStarted:
                case ScribeStatusKind.Ready:
                    // Only reset to idle if currently in recording state (e.g., discard path).
                    // Processing and terminal states are authoritative — ignore stale READY.
                    if (_scribePhase == ScribePhase.Recording || _scribePhase == ScribePhase.Paused)
                    {
                        _scribePhase = ScribePhase.Idle;
                        RefreshOverlayVisibility();
                    }
                    break;
                case ScribeStatusKind.Unknown:
                default:
                    break;
            }

            if (normalized is not ScribeStatusKind.Recording and not ScribeStatusKind.Paused)
            {
                ShortcutRecordingDebounce.Clear();
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge->Overlay] malformed scribe.status payload: {ex.Message}");
        }
    }

    private void HandleScribeError(JsonElement payload)
    {
        try
        {
            var errorMessage = payload.TryGetProperty("errorMessage", out var msgElem)
                ? msgElem.GetString()
                : null;
            SetTerminalPhase(ScribePhase.Error, errorMessage: errorMessage, transactionId: null);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge->Overlay] malformed scribe.error payload: {ex.Message}");
        }
    }

    private void HandleScribeProcessingCompleted(JsonElement payload)
    {
        try
        {
            var transactionId = payload.TryGetProperty("transactionId", out var txElem)
                ? txElem.GetString()
                : null;
            SetTerminalPhase(ScribePhase.Completed, errorMessage: null, transactionId: transactionId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge->Overlay] malformed scribe.processing.completed payload: {ex.Message}");
        }
    }

    private void HandleAppFocusChanged(JsonElement payload)
    {
        try
        {
            var isFocused = payload.GetProperty("isFocused").GetBoolean();
            _isElectronFocused = isFocused;

            if (isFocused && (_scribePhase == ScribePhase.Error || _scribePhase == ScribePhase.Completed))
            {
                // Electron gained focus during a terminal state — user already sees the result;
                // consume it so no overlay appears. Mirrors macOS handleElectronFocusChanged.
                _scribePhase = ScribePhase.Idle;
            }

            Console.WriteLine($"[Bridge->Overlay] HandleAppFocusChanged isFocused={isFocused} scribePhase={_scribePhase}");

            // Always re-drive scribe overlay visibility for the new focus state.
            // Prompt visibility is owned by MicrophoneMonitorService and is not
            // focus-gated. Mirrors macOS BridgeAppState.handleElectronFocusChanged.
            RefreshOverlayVisibility();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge->Overlay] malformed app.focus.changed payload: {ex.Message}");
        }
    }

    private void SetTerminalPhase(ScribePhase phase, string? errorMessage, string? transactionId)
    {
        // Always cache the pending terminal data FIRST so RefreshOverlayVisibility
        // can pick it up later (e.g. when Electron loses focus after this call).
        // Mirrors macOS: _pendingTransactionId / _pendingErrorMessage are always
        // written before refreshOverlayVisibility is called.
        if (phase == ScribePhase.Error)
            _overlayWindowController?.DispatchSetPendingErrorState(errorMessage);
        else
            _overlayWindowController?.DispatchSetPendingTransactionId(transactionId ?? string.Empty);

        // Mirror macOS setTerminalPhase: set phase to Idle if focused (consumed),
        // keep terminal phase if Electron is in the background.
        _scribePhase = _isElectronFocused ? ScribePhase.Idle : phase;

        Console.WriteLine($"[Bridge->Overlay] SetTerminalPhase requested={phase} focused={_isElectronFocused} => scribePhase={_scribePhase}");

        // Always re-drive overlay from the resolved phase.
        // Mirrors macOS setTerminalPhase which always calls refreshOverlayVisibility().
        RefreshOverlayVisibility();
    }

    /// <summary>
    /// Maps the current <see cref="_scribePhase"/> to the correct overlay UI state
    /// and drives the state store. Suppresses active scribe overlays when Electron is
    /// focused. Prompt visibility is owned by <see cref="MicrophoneMonitorService"/>.
    /// Mirrors macOS <c>BridgeAppState.refreshOverlayVisibility()</c>.
    /// </summary>
    private void RefreshOverlayVisibility()
    {
        if (_scribePhase == ScribePhase.Idle)
        {
            // Prompt is mic-driven; never clear it from the scribe refresh path.
            return;
        }

        OverlayUiState? next = _scribePhase switch
        {
            ScribePhase.Recording or ScribePhase.Paused => OverlayUiState.Recording,
            ScribePhase.Processing => OverlayUiState.Processing,
            ScribePhase.Completed => OverlayUiState.Processed,
            ScribePhase.Error => OverlayUiState.Error,
            _ => null,
        };

        if (next == null)
        {
            return;
        }

        if (_isElectronFocused)
        {
            if (_overlayStateStore?.Current == OverlayUiState.Prompt)
            {
                return;
            }

            _overlayStateStore?.Set(null, source: "electron-focused");
            return;
        }

        _overlayStateStore?.Set(next, source: "refresh");
        ManageProcessingTimeout();
    }

    private void ManageProcessingTimeout()
    {
        _processingTimer?.Dispose();
        _processingTimer = null;
        if (_scribePhase != ScribePhase.Processing) return;
        _processingTimer = new Timer(_ =>
        {
            if (_scribePhase != ScribePhase.Processing) return;
            Console.WriteLine($"[WinHelper] processing phase auto-reset after {ProcessingTimeoutSeconds}s timeout");
            _scribePhase = ScribePhase.Idle;
            RefreshOverlayVisibility();
        }, null, ProcessingTimeoutSeconds * 1000, Timeout.Infinite);
    }

    private async Task RestartBridgeConnectionAsync(string reason)
    {
        if (_client == null || _cts == null) return;
        if (Interlocked.Exchange(ref _bridgeReconnectInProgress, 1) == 1) return;

        try
        {
            Console.WriteLine($"[Bridge] reconnect requested: {reason}");
            await _client.StopAsync(CancellationToken.None);
            await Task.Delay(200);
            await _client.StartAsync(_cts.Token);
            Console.WriteLine("[Bridge] reconnect completed");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bridge] reconnect failed: {ex.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _bridgeReconnectInProgress, 0);
        }
    }

    public static bool HasBridgeStdioFlag(string[] args)
    {
        foreach (var arg in args)
        {
            if (string.Equals(arg, "--bridge-stdio", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    public static int? TryGetBridgePort(string[] args)
    {
        foreach (var arg in args)
        {
            if (!arg.StartsWith("--bridge-port=", StringComparison.OrdinalIgnoreCase)) continue;
            var value = arg.Substring("--bridge-port=".Length);
            if (int.TryParse(value, out var port) && port is > 0 and <= 65535) return port;
        }
        return null;
    }

    public static string? TryGetBridgeHost(string[] args)
    {
        foreach (var arg in args)
        {
            if (!arg.StartsWith("--bridge-host=", StringComparison.OrdinalIgnoreCase)) continue;
            var value = arg.Substring("--bridge-host=".Length).Trim();
            if (string.IsNullOrWhiteSpace(value)) return null;

            if (string.Equals(value, "localhost", StringComparison.OrdinalIgnoreCase)) return "127.0.0.1";
            if (IPAddress.TryParse(value, out _)) return value;
        }

        return null;
    }

    private static ScribeStatusKind NormalizeStatus(string? status)
    {
        if (string.IsNullOrWhiteSpace(status)) return ScribeStatusKind.Unknown;

        var normalized = status.Trim().Replace('-', '_').ToUpperInvariant();
        return normalized switch
        {
            "NOT_STARTED" => ScribeStatusKind.NotStarted,
            "READY" => ScribeStatusKind.Ready,
            "PAUSED" or "RECORDING_PAUSED" => ScribeStatusKind.Paused,
            "RECORDING" or "RECORDING_STARTED" or "STARTED" or "IN_PROGRESS" or "RUNNING" or "RESUME" or "RECORDING_RESUMED" or "RECORDING_STOPPED" => ScribeStatusKind.Recording,
            "ANALYZING" or "ANALYSING" or "PROCESSING" => ScribeStatusKind.Analyzing,
            "OUTPUT_GENERATED" => ScribeStatusKind.OutputGenerated,
            "ANALYZING_FAILED" => ScribeStatusKind.AnalyzingFailed,
            "INITIALIZING" => ScribeStatusKind.Initializing,
            _ => ScribeStatusKind.Ready,
        };
    }

    private enum ScribeStatusKind
    {
        Unknown = 0,
        NotStarted = 1,
        Ready = 2,
        Recording = 3,
        Paused = 4,
        Analyzing = 5,
        OutputGenerated = 6,
        AnalyzingFailed = 7,
        Initializing = 8,
    }

    private enum ScribePhase
    {
        Idle,
        Recording,
        Paused,
        Processing,
        Error,
        Completed,
    }
}
