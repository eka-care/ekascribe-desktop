using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;

namespace EkaDeskDocHelper.ViewModels;

internal sealed class PromptOverlayViewModel : INotifyPropertyChanged
{
    private readonly DispatcherTimer _timer;
    private readonly Stopwatch _sw = new();
    private TimeSpan _duration = TimeSpan.FromSeconds(30);
    private double _progressPercent;
    private string _remainingText = "00:30";
    private string? _triggeringAppName;

    public double ProgressPercent
    {
        get => _progressPercent;
        private set
        {
            if (Math.Abs(_progressPercent - value) < 0.001) return;
            _progressPercent = value;
            OnPropertyChanged();
        }
    }

    public string RemainingText
    {
        get => _remainingText;
        private set
        {
            if (string.Equals(_remainingText, value, StringComparison.Ordinal)) return;
            _remainingText = value;
            OnPropertyChanged();
        }
    }

    public string? TriggeringAppName
    {
        get => _triggeringAppName;
        set
        {
            if (string.Equals(_triggeringAppName, value, StringComparison.Ordinal)) return;
            _triggeringAppName = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(TriggeringAppNameVisibility));
        }
    }

    public Visibility TriggeringAppNameVisibility =>
        string.IsNullOrEmpty(_triggeringAppName) ? Visibility.Collapsed : Visibility.Visible;

    public ICommand DismissCommand { get; }
    public ICommand StartCommand { get; }

    public event EventHandler? DismissRequested;
    public event EventHandler? StartRequested;

    public PromptOverlayViewModel()
    {
        _timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(50),
        };
        _timer.Tick += (_, _) => OnTick();

        DismissCommand = new RelayCommand(() => DismissRequested?.Invoke(this, EventArgs.Empty));
        StartCommand = new RelayCommand(() => StartRequested?.Invoke(this, EventArgs.Empty));
    }

    public void StartCountdown(TimeSpan? duration = null)
    {
        _duration = duration ?? TimeSpan.FromSeconds(30);
        if (_duration <= TimeSpan.Zero) _duration = TimeSpan.FromSeconds(30);

        ProgressPercent = 100;
        RemainingText = FormatRemaining(_duration);
        _sw.Restart();
        _timer.Start();
    }

    public void StopCountdown()
    {
        _timer.Stop();
        _sw.Reset();
        ProgressPercent = 0;
        RemainingText = FormatRemaining(_duration);
    }

    private void OnTick()
    {
        var elapsed = _sw.Elapsed;
        var remainingRatio = 1.0 - (elapsed.TotalMilliseconds / _duration.TotalMilliseconds);
        var pct = Math.Clamp(remainingRatio, 0, 1) * 100.0;
        ProgressPercent = pct;
        RemainingText = FormatRemaining(TimeSpan.FromMilliseconds(Math.Max(0, _duration.TotalMilliseconds - elapsed.TotalMilliseconds)));

        if (elapsed >= _duration)
        {
            _timer.Stop();
            DismissRequested?.Invoke(this, EventArgs.Empty);
        }
    }

    private static string FormatRemaining(TimeSpan remaining) =>
        remaining.TotalHours >= 1 ? remaining.ToString(@"hh\:mm\:ss") : remaining.ToString(@"mm\:ss");

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
