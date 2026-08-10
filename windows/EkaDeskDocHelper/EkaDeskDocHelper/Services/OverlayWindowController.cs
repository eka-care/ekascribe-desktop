using System;
using System.Windows.Threading;

namespace EkaDeskDocHelper.Services;

internal sealed class OverlayWindowController : IDisposable
{
    private readonly Dispatcher _dispatcher;
    private readonly IOverlayStateStore _overlayStateStore;
    private readonly IElectronBridgeClient? _electronBridgeClient;
    private readonly IOverlayShortcutPreferencesStore? _shortcutPreferencesStore;
    private MainWindow? _promptWindow;
    private RecordingOverlayWindow? _recordingWindow;
    private ProcessingOverlayWindow? _processingWindow;
    private ProcessedOverlayWindow? _processedWindow;
    private ErrorOverlayWindow? _errorWindow;
    private bool _disposed;
    private string? _pendingTransactionId;
    private string? _pendingErrorMessage;

    public OverlayWindowController(
        Dispatcher dispatcher,
        IOverlayStateStore overlayStateStore,
        IElectronBridgeClient? electronBridgeClient = null,
        IOverlayShortcutPreferencesStore? shortcutPreferencesStore = null)
    {
        _dispatcher = dispatcher;
        _overlayStateStore = overlayStateStore;
        _electronBridgeClient = electronBridgeClient;
        _shortcutPreferencesStore = shortcutPreferencesStore;
        // Keep prompt window initialized (hidden) so global hotkeys register at startup.
        EnsurePromptWindow();
        _overlayStateStore.Changed += OnOverlayStateChanged;
    }

    private void OnOverlayStateChanged(object? sender, OverlayVisibilityChangedEventArgs e)
    {
        if (_disposed) return;
        // Pure store renderer (mirrors macOS OverlayWindowController.bindPresentationState):
        // focus suppression is already applied upstream by RefreshOverlayVisibility,
        // which sets the store to null when Electron is focused.
        _ = _dispatcher.BeginInvoke(() =>
        {
            ApplyPromptState(e.Next);
        }, DispatcherPriority.Normal);
    }

    private void EnsurePromptWindow()
    {
        if (_promptWindow != null) return;
        _promptWindow = new MainWindow(_overlayStateStore, _electronBridgeClient, _shortcutPreferencesStore);
        _promptWindow.Hide();
    }

    private void EnsureRecordingWindow()
    {
        if (_recordingWindow != null) return;
        _recordingWindow = new RecordingOverlayWindow(_overlayStateStore, _electronBridgeClient);
        _recordingWindow.Hide();
    }

    private void EnsureProcessingWindow()
    {
        if (_processingWindow != null) return;
        _processingWindow = new ProcessingOverlayWindow(_electronBridgeClient);
        _processingWindow.Hide();
    }

    private void EnsureProcessedWindow()
    {
        if (_processedWindow != null) return;
        _processedWindow = new ProcessedOverlayWindow(_overlayStateStore, _electronBridgeClient);
        _processedWindow.Hide();
    }

    private void EnsureErrorWindow()
    {
        if (_errorWindow != null) return;
        _errorWindow = new ErrorOverlayWindow(_overlayStateStore, _electronBridgeClient);
        _errorWindow.Hide();
    }

    private void ApplyPromptState(OverlayUiState? state)
    {
        if (_disposed) return;
        switch (state)
        {
            case OverlayUiState.Prompt:
                ShowPromptOverlay(_overlayStateStore.PromptTriggeringApp);
                break;
            case OverlayUiState.Recording:
                ShowRecordingOverlay();
                break;
            case OverlayUiState.Processing:
                ShowProcessingOverlay();
                break;
            case OverlayUiState.Processed:
                // Store-driven (mirrors macOS refreshOverlayVisibility). The completion
                // event captures the transaction id into _pendingTransactionId first, so
                // the processed overlay also recovers when focus suppression clears.
                ShowProcessedOverlay(_pendingTransactionId ?? string.Empty);
                break;
            case OverlayUiState.Error:
                ShowErrorOverlay(_pendingErrorMessage);
                break;
            case null:
                HideAllOverlaysAnimated();
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown overlay state");
        }
    }

    public void ShowPromptOverlay(string? appName = null)
    {
        if (_disposed) return;
        EnsurePromptWindow();
        _recordingWindow?.HideOverlayAnimated();
        _processingWindow?.HideOverlayAnimated();
        _processedWindow?.HideOverlayAnimated();
        _promptWindow?.ShowOverlayAnimated(appName);
    }

    public void ShowRecordingOverlay()
    {
        if (_disposed) return;
        EnsureRecordingWindow();
        _promptWindow?.HideOverlayAnimated();
        _processingWindow?.HideOverlayAnimated();
        _processedWindow?.HideOverlayAnimated();
        _recordingWindow?.ShowOverlayAnimated();
    }

    public void ShowProcessingOverlay()
    {
        if (_disposed) return;
        EnsureProcessingWindow();
        _promptWindow?.HideOverlayAnimated();
        _recordingWindow?.HideOverlayAnimated();
        _processedWindow?.HideOverlayAnimated();
        _processingWindow?.ShowOverlayAnimated();
    }

    public void ShowProcessedOverlay(string transactionId)
    {
        if (_disposed) return;
        _pendingTransactionId = transactionId;
        EnsureProcessedWindow();
        _promptWindow?.HideOverlayAnimated();
        _recordingWindow?.HideOverlayAnimated();
        _processingWindow?.HideOverlayAnimated();
        _processedWindow?.ShowOverlayAnimated(transactionId);
    }

    public void ShowErrorOverlay(string? message)
    {
        if (_disposed) return;
        _pendingErrorMessage = message;
        EnsureErrorWindow();
        _promptWindow?.HideOverlayAnimated();
        _recordingWindow?.HideOverlayAnimated();
        _processingWindow?.HideOverlayAnimated();
        _processedWindow?.HideOverlayAnimated();
        _errorWindow?.ShowOverlayAnimated(message);
    }

    public void HideAllOverlaysAnimated()
    {
        if (_disposed) return;
        _promptWindow?.HideOverlayAnimated();
        _recordingWindow?.HideOverlayAnimated();
        _processingWindow?.HideOverlayAnimated();
        _processedWindow?.HideOverlayAnimated();
        _errorWindow?.HideOverlayAnimated();
    }

    public void DispatchShowRecordingOverlay()
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(ShowRecordingOverlay, DispatcherPriority.Normal);
    }

    public void DispatchSetRecordingPaused(bool isPaused)
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(() =>
        {
            EnsureRecordingWindow();
            _recordingWindow?.SetPaused(isPaused);
        }, DispatcherPriority.Normal);
    }

    public void DispatchShowProcessingOverlay()
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(ShowProcessingOverlay, DispatcherPriority.Normal);
    }

    public void DispatchShowProcessedOverlay(string transactionId)
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(() => ShowProcessedOverlay(transactionId), DispatcherPriority.Normal);
    }

    public void DispatchSetPendingErrorState(string? message)
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(() =>
        {
            _pendingErrorMessage = message;
        }, DispatcherPriority.Normal);
    }

    /// <summary>
    /// Caches the pending transaction id without showing the processed overlay.
    /// Used by RefreshOverlayVisibility so the id is available when the overlay
    /// is shown later (e.g. when Electron loses focus after a terminal phase was
    /// set while Electron was focused). Mirrors the macOS pattern where
    /// <c>_pendingTransactionId</c> is always written before visibility is driven.
    /// </summary>
    public void DispatchSetPendingTransactionId(string transactionId)
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(() =>
        {
            _pendingTransactionId = transactionId;
        }, DispatcherPriority.Normal);
    }

    public void DispatchHideAllOverlays()
    {
        if (_disposed) return;
        _ = _dispatcher.BeginInvoke(HideAllOverlaysAnimated, DispatcherPriority.Normal);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _overlayStateStore.Changed -= OnOverlayStateChanged;

        _dispatcher.Invoke(() =>
        {
            try { _promptWindow?.Close(); } catch { /* best-effort */ }
            try { _recordingWindow?.Close(); } catch { /* best-effort */ }
            try { _processingWindow?.Close(); } catch { /* best-effort */ }
            try { _processedWindow?.Close(); } catch { /* best-effort */ }
            try { _errorWindow?.Close(); } catch { /* best-effort */ }
            _promptWindow = null;
            _recordingWindow = null;
            _processingWindow = null;
            _processedWindow = null;
            _errorWindow = null;
        });
    }
}

