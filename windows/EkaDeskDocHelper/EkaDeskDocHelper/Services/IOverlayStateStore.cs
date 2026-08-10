using System;

namespace EkaDeskDocHelper.Services;

public interface IOverlayStateStore
{
    OverlayUiState? Current { get; }
    string? PromptTriggeringApp { get; }

    event EventHandler<OverlayVisibilityChangedEventArgs>? Changed;

    void Set(OverlayUiState? next, string source);
    void SetPrompt(string? appName, string source);
}

public sealed class OverlayVisibilityChangedEventArgs : EventArgs
{
    public OverlayVisibilityChangedEventArgs(OverlayUiState? previous, OverlayUiState? next, string source)
    {
        Previous = previous;
        Next = next;
        Source = source;
    }

    public OverlayUiState? Previous { get; }
    public OverlayUiState? Next { get; }
    public string Source { get; }
}

