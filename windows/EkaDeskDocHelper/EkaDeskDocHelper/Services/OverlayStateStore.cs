using System;
//https://www.figma.com/design/GLYOk2uhPsejtzMLyap7i3/EkaScribe?node-id=658-10156&t=dgMqJQpgB4OBgOMv-4
namespace EkaDeskDocHelper.Services;

internal sealed class OverlayStateStore : IOverlayStateStore
{
    public static OverlayStateStore Instance { get; } = new();

    private readonly object _gate = new();
    private OverlayUiState? _current;
    private string? _promptTriggeringApp;

    private OverlayStateStore()
    {
    }

    public OverlayUiState? Current
    {
        get
        {
            lock (_gate) return _current;
        }
    }

    public string? PromptTriggeringApp
    {
        get { lock (_gate) return _promptTriggeringApp; }
    }

    public event EventHandler<OverlayVisibilityChangedEventArgs>? Changed;

    public void Set(OverlayUiState? next, string source)
    {
        OverlayUiState? prev;
        lock (_gate)
        {
            prev = _current;
            if (prev == next) return;
            _current = next;
            if (next != OverlayUiState.Prompt) _promptTriggeringApp = null;
        }

        Changed?.Invoke(this, new OverlayVisibilityChangedEventArgs(prev, next, source));
    }

    public void SetPrompt(string? appName, string source)
    {
        OverlayUiState? prev;
        lock (_gate)
        {
            prev = _current;
            _promptTriggeringApp = appName;
            if (prev == OverlayUiState.Prompt)
            {
                // State unchanged but app name may have changed — no event needed.
                return;
            }
            _current = OverlayUiState.Prompt;
        }

        Changed?.Invoke(this, new OverlayVisibilityChangedEventArgs(prev, OverlayUiState.Prompt, source));
    }
}

