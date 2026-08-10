using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using EkaDeskDocHelper.Services;
using EkaDeskDocHelper.ViewModels;

namespace EkaDeskDocHelper;

public partial class RecordingOverlayWindow : Window
{
    private const int NativeEventCooldownMs = 600;
    private bool _isShown;
    private readonly IOverlayStateStore _overlayStateStore;
    private readonly IElectronBridgeClient? _electronBridgeClient;
    private readonly IOverlayLayoutPreferencesStore _layoutStore = OverlayLayoutPreferencesStore.Instance;
    private readonly RecordingOverlayViewModel _viewModel;
    private readonly List<BitmapFrame> _gifFrames = [];
    private readonly List<TimeSpan> _gifFrameDurations = [];
    private readonly DispatcherTimer _gifTimer;
    private int _gifFrameIndex;
    private const double PillCornerRadius = 24;
    private DateTime _lastPauseToggleSentAtUtc = DateTime.MinValue;
    private DateTime _lastStopSentAtUtc = DateTime.MinValue;

    internal RecordingOverlayWindow(IOverlayStateStore overlayStateStore, IElectronBridgeClient? electronBridgeClient = null)
    {
        _overlayStateStore = overlayStateStore ?? throw new ArgumentNullException(nameof(overlayStateStore));
        _electronBridgeClient = electronBridgeClient;
        _viewModel = new RecordingOverlayViewModel();
        _gifTimer = new DispatcherTimer(DispatcherPriority.Render)
        {
            Interval = TimeSpan.FromMilliseconds(100),
        };
        _gifTimer.Tick += OnGifFrameTick;
        _viewModel.PauseToggledRequested += async (_, isPaused) =>
        {
            SetGifPausedState(isPaused);
            try
            {
                if (DateTime.UtcNow - _lastPauseToggleSentAtUtc < TimeSpan.FromMilliseconds(NativeEventCooldownMs))
                {
                    Console.WriteLine("[OverlayUI] skipping duplicate pause/resume click");
                    return;
                }
                _lastPauseToggleSentAtUtc = DateTime.UtcNow;
                if (_electronBridgeClient != null)
                {
                    await _electronBridgeClient.SendEventAsync(isPaused ? "recording.pause" : "recording.resume",
                        payload: null,
                        CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to send {(isPaused ? "recording.pause" : "recording.resume")}: {ex.Message}");
            }
        };
        _viewModel.StopRequested += async (_, _) =>
        {
            try
            {
                if (DateTime.UtcNow - _lastStopSentAtUtc < TimeSpan.FromMilliseconds(NativeEventCooldownMs))
                {
                    Console.WriteLine("[OverlayUI] skipping duplicate stop click");
                    return;
                }
                _lastStopSentAtUtc = DateTime.UtcNow;
                if (_electronBridgeClient != null)
                {
                    await _electronBridgeClient.SendEventAsync("recording.stop", payload: null, CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to send recording.stop: {ex.Message}");
            }
            _overlayStateStore.Set(null, source: "overlay-ui");
        };

        InitializeComponent();
        DataContext = _viewModel;
        _viewModel.LayoutOrientation = _layoutStore.Current.IsVertical
            ? System.Windows.Controls.Orientation.Vertical
            : System.Windows.Controls.Orientation.Horizontal;
        _layoutStore.Changed += OnLayoutChanged;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        PillClipHost.SizeChanged += (_, _) => UpdatePillClip();
        Loaded += (_, _) =>
        {
            UpdatePillClip();
            PositionTopCenter();
            StartGifAnimationIfAvailable();
        };
        SizeChanged += (_, _) => PositionTopCenter();
        Unloaded += (_, _) => StopGifAnimation();
    }

    private void UpdatePillClip()
    {
        var w = PillClipHost.ActualWidth;
        var h = PillClipHost.ActualHeight;
        if (w <= 0 || h <= 0)
        {
            PillClipHost.Clip = null;
            return;
        }

        var radius = Math.Min(PillCornerRadius, h / 2);
        PillClipHost.Clip = new RectangleGeometry(new Rect(0, 0, w, h), radius, radius);
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var hwnd = new WindowInteropHelper(this).Handle;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_APPWINDOW = 0x00040000;
        var exStyle = NativeMethods.GetWindowLong(hwnd, GWL_EXSTYLE);
        exStyle &= ~WS_EX_APPWINDOW;
        exStyle |= WS_EX_TOOLWINDOW;
        NativeMethods.SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
    }

    internal void ShowOverlayAnimated()
    {
        if (_isShown && IsVisible) return;

        _isShown = true;
        if (!IsVisible) Show();
        PositionTopCenter();

        if (TryFindResource("OverlayShowStoryboard") is Storyboard sb)
        {
            sb.Stop(this);
            sb.Begin(this, true);
        }

        StartGifAnimationIfAvailable();
    }

    internal void HideOverlayAnimated()
    {
        if (!_isShown && !IsVisible) return;

        _isShown = false;

        if (TryFindResource("OverlayHideStoryboard") is not Storyboard sb)
        {
            Hide();
            return;
        }

        sb.Stop(this);
        sb.Completed -= OnHideStoryboardCompleted;
        sb.Completed += OnHideStoryboardCompleted;
        sb.Begin(this, true);
        StopGifAnimation();
    }

    private void CloseOverlayButton_Click(object sender, RoutedEventArgs e)
    {
        try { _overlayStateStore.Set(null, source: "overlay-ui"); } catch { /* best-effort */ }
        try { HideOverlayAnimated(); } catch { /* best-effort */ }
    }

    private void OnHideStoryboardCompleted(object? sender, EventArgs e)
    {
        if (_isShown) return;
        Hide();
    }

    protected override void OnClosed(EventArgs e)
    {
        StopGifAnimation();
        _gifTimer.Tick -= OnGifFrameTick;
        _layoutStore.Changed -= OnLayoutChanged;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        base.OnClosed(e);
    }

    private void PositionTopCenter()
    {
        // Honors the user's dragged top-left anchor (shared across all overlay
        // states) and falls back to top-center when no custom position is set.
        OverlayPositioning.ApplyStoredOrTopCenter(this, topPadding: 12.0);
    }

    private void DragHandle_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        try
        {
            DragMove();
        }
        catch (InvalidOperationException)
        {
            // DragMove throws if the button is no longer pressed; ignore.
        }
        finally
        {
            ClampAndPersistPosition();
        }
    }

    private void ClampAndPersistPosition()
    {
        var (left, top) = OverlayPositioning.Clamp(Left, Top, ActualWidth, ActualHeight);
        Left = left;
        Top = top;
        _layoutStore.UpdatePosition(left, top);
    }

    private async void LogoButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_electronBridgeClient != null)
            {
                await _electronBridgeClient.SendEventAsync("overlay.open.app", payload: null, CancellationToken.None);
                Console.WriteLine("[OverlayUI] -> event overlay.open.app");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[OverlayUI] failed to send overlay.open.app: {ex.Message}");
        }
    }

    private void OrientationToggleButton_Click(object sender, RoutedEventArgs e)
    {
        _layoutStore.ToggleOrientation();
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        // Resolution / monitor changes can push the overlay off-screen; re-clamp.
        _ = Dispatcher.BeginInvoke(() =>
        {
            if (_layoutStore.Current.HasCustomPosition)
            {
                ClampAndPersistPosition();
            }
            else
            {
                PositionTopCenter();
            }
        });
    }

    private void OnLayoutChanged(object? sender, OverlayLayoutPreferences prefs)
    {
        _ = Dispatcher.BeginInvoke(() =>
        {
            _viewModel.LayoutOrientation = prefs.IsVertical
                ? System.Windows.Controls.Orientation.Vertical
                : System.Windows.Controls.Orientation.Horizontal;
            // Re-anchor (clamped) after an orientation resize or a position update.
            PositionTopCenter();
        });
    }

    internal void SetPaused(bool isPaused)
    {
        _viewModel.SetPausedFromBridge(isPaused);
        SetGifPausedState(isPaused);
    }

    private void StartGifAnimationIfAvailable()
    {
        if (_gifFrames.Count == 0)
        {
            LoadGifFrames();
        }

        if (_gifFrames.Count == 0)
        {
            return;
        }

        _gifFrameIndex = Math.Clamp(_gifFrameIndex, 0, _gifFrames.Count - 1);
        RecordingGifImage.Source = _gifFrames[_gifFrameIndex];
        if (_viewModel.IsPaused)
        {
            _gifTimer.Stop();
            return;
        }

        _gifTimer.Interval = _gifFrameDurations[_gifFrameIndex];
        if (!_gifTimer.IsEnabled)
        {
            _gifTimer.Start();
        }
    }

    private void StopGifAnimation()
    {
        _gifTimer.Stop();
    }

    private void SetGifPausedState(bool isPaused)
    {
        if (isPaused)
        {
            StopGifAnimation();
            return;
        }

        if (_isShown && IsVisible)
        {
            StartGifAnimationIfAvailable();
        }
    }

    private void OnGifFrameTick(object? sender, EventArgs e)
    {
        if (_gifFrames.Count == 0)
        {
            _gifTimer.Stop();
            return;
        }

        _gifFrameIndex = (_gifFrameIndex + 1) % _gifFrames.Count;
        RecordingGifImage.Source = _gifFrames[_gifFrameIndex];
        _gifTimer.Interval = _gifFrameDurations[_gifFrameIndex];
    }

    private void LoadGifFrames()
    {
        try
        {
            var gifUri = new Uri("pack://application:,,,/Assets/voice-recording.gif", UriKind.Absolute);
            var streamInfo = Application.GetResourceStream(gifUri);
            if (streamInfo?.Stream is null)
            {
                return;
            }

            using var stream = streamInfo.Stream;
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            memory.Position = 0;

            var decoder = new GifBitmapDecoder(memory, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            foreach (var frame in decoder.Frames)
            {
                _gifFrames.Add(frame);
                _gifFrameDurations.Add(GetFrameDuration(frame));
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[OverlayUI] failed to load recording gif: {ex.Message}");
        }
    }

    private static TimeSpan GetFrameDuration(BitmapFrame frame)
    {
        const double DefaultFrameMs = 100;
        try
        {
            if (frame.Metadata is not BitmapMetadata metadata || !metadata.ContainsQuery("/grctlext/Delay"))
            {
                return TimeSpan.FromMilliseconds(DefaultFrameMs);
            }

            var delayObj = metadata.GetQuery("/grctlext/Delay");
            if (delayObj is not ushort delayCentiseconds || delayCentiseconds == 0)
            {
                return TimeSpan.FromMilliseconds(DefaultFrameMs);
            }

            var ms = delayCentiseconds * 10.0;
            return TimeSpan.FromMilliseconds(ms < 20 ? DefaultFrameMs : ms);
        }
        catch
        {
            return TimeSpan.FromMilliseconds(DefaultFrameMs);
        }
    }

    internal static class NativeMethods
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    }
}
