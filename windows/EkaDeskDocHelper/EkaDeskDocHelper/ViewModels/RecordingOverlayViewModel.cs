using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace EkaDeskDocHelper.ViewModels;

internal sealed class RecordingOverlayViewModel : INotifyPropertyChanged
{
    public ICommand StopCommand { get; }
    public ICommand PauseCommand { get; }

    public event EventHandler? StopRequested;
    public event EventHandler<bool>? PauseToggledRequested;

    private bool _isPaused;
    private System.Windows.Controls.Orientation _layoutOrientation = System.Windows.Controls.Orientation.Horizontal;

    public bool IsPaused
    {
        get => _isPaused;
        private set
        {
            if (_isPaused == value) return;
            _isPaused = value;
            OnPropertyChangedForPauseState();
        }
    }

    /// <summary>Orientation of the recording pill's content stack.</summary>
    public System.Windows.Controls.Orientation LayoutOrientation
    {
        get => _layoutOrientation;
        set
        {
            if (_layoutOrientation == value) return;
            _layoutOrientation = value;
            OnPropertyChanged(nameof(LayoutOrientation));
            OnPropertyChanged(nameof(IsVertical));
        }
    }

    public bool IsVertical => _layoutOrientation == System.Windows.Controls.Orientation.Vertical;

    public RecordingOverlayViewModel()
    {
        StopCommand = new RelayCommand(() => StopRequested?.Invoke(this, EventArgs.Empty));
        PauseCommand = new RelayCommand(TogglePause);
    }

    private void TogglePause()
    {
        IsPaused = !IsPaused;
        PauseToggledRequested?.Invoke(this, IsPaused);
    }

    public void SetPausedFromBridge(bool isPaused)
    {
        if (IsPaused == isPaused) return;
        IsPaused = isPaused;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));

    private void OnPropertyChangedForPauseState()
    {
        OnPropertyChanged(nameof(IsPaused));
    }
}
