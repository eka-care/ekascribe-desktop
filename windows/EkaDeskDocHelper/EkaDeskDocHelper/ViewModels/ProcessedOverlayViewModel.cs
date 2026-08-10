using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using System.Windows.Threading;

namespace EkaDeskDocHelper.ViewModels;

internal sealed class ProcessedOverlayViewModel : INotifyPropertyChanged
{
    private readonly DispatcherTimer _timer;
    private readonly Stopwatch _sw = new();
    private TimeSpan _duration = TimeSpan.FromSeconds(10);
    private string? _transactionId;
    private string _transactionAutomationId = "no-transaction-id";
    private double _progressPercent;

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

    public ICommand DismissCommand { get; }
    public ICommand ViewCommand { get; }
    public string TransactionAutomationId
    {
        get => _transactionAutomationId;
        private set
        {
            if (string.Equals(_transactionAutomationId, value, StringComparison.Ordinal)) return;
            _transactionAutomationId = value;
            OnPropertyChanged();
        }
    }

    public event EventHandler? DismissRequested;
    public event EventHandler<string>? ViewRequested;

    public ProcessedOverlayViewModel()
    {
        _timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(50),
        };
        _timer.Tick += (_, _) => OnTick();

        DismissCommand = new RelayCommand(() => DismissRequested?.Invoke(this, EventArgs.Empty));
        ViewCommand = new RelayCommand(() =>
        {
            // Always treat "View" as an intent: open + hide overlay even if transactionId is missing.
            ViewRequested?.Invoke(this, _transactionId ?? string.Empty);
        });
    }

    public void SetTransactionId(string transactionId)
    {
        _transactionId = transactionId;
        TransactionAutomationId = string.IsNullOrWhiteSpace(transactionId) ? "no-transaction-id" : transactionId;
    }

    public void StartCountdown(TimeSpan? duration = null)
    {
        _duration = duration ?? TimeSpan.FromSeconds(10);
        if (_duration <= TimeSpan.Zero) _duration = TimeSpan.FromSeconds(10);

        ProgressPercent = 100;
        _sw.Restart();
        _timer.Start();
    }

    public void StopCountdown()
    {
        _timer.Stop();
        _sw.Reset();
        ProgressPercent = 100;
    }

    private void OnTick()
    {
        var elapsed = _sw.Elapsed;
        var pct = (1.0 - Math.Clamp(elapsed.TotalMilliseconds / _duration.TotalMilliseconds, 0, 1)) * 100.0;
        ProgressPercent = pct;

        if (elapsed >= _duration)
        {
            _timer.Stop();
            DismissRequested?.Invoke(this, EventArgs.Empty);
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
