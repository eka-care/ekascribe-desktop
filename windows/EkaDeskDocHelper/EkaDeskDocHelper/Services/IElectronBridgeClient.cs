using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace EkaDeskDocHelper.Services;

internal interface IElectronBridgeClient : IAsyncDisposable
{
    event EventHandler<BridgeConnectionStateChangedEventArgs>? ConnectionStateChanged;
    event EventHandler<BridgeEventReceivedEventArgs>? EventReceived;

    bool IsConnected { get; }

    /// <summary>True when IPC uses stdin/stdout (parent-owned lifecycle).</summary>
    bool IsStdioTransport { get; }

    /// <summary>
    /// Optional handler invoked when Electron sends an inbound `request`
    /// message. Return a payload to reply successfully, or throw to reply
    /// with an error. Handlers must be fast and non-blocking.
    /// </summary>
    Func<string, JsonElement?, Task<object?>>? RequestHandler { get; set; }

    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);

    Task SendEventAsync(string eventName, object? payload, CancellationToken cancellationToken);
    Task<System.Text.Json.JsonElement?> SendRequestAsync(string name, object? payload, TimeSpan timeout, CancellationToken cancellationToken);
}

internal sealed class BridgeConnectionStateChangedEventArgs : EventArgs
{
    public bool IsConnected { get; }
    public string? Reason { get; }

    public BridgeConnectionStateChangedEventArgs(bool isConnected, string? reason = null)
    {
        IsConnected = isConnected;
        Reason = reason;
    }
}

internal sealed class BridgeEventReceivedEventArgs : EventArgs
{
    public string EventName { get; }
    public JsonElement? Payload { get; }

    public BridgeEventReceivedEventArgs(string eventName, JsonElement? payload)
    {
        EventName = eventName;
        Payload = payload;
    }
}

