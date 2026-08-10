using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using EkaDeskDocHelper.Services;
using EkaDeskDocHelper.ViewModels;

namespace EkaDeskDocHelper;

public partial class ErrorOverlayWindow : Window
{
    private bool _isShown;
    private readonly IOverlayStateStore _overlayStateStore;
    private readonly IElectronBridgeClient? _electronBridgeClient;
    private readonly IOverlayLayoutPreferencesStore _layoutStore = OverlayLayoutPreferencesStore.Instance;
    private readonly ErrorOverlayViewModel _viewModel;
    private const double PillCornerRadius = 14;

    internal ErrorOverlayWindow(IOverlayStateStore overlayStateStore, IElectronBridgeClient? electronBridgeClient = null)
    {
        _overlayStateStore = overlayStateStore ?? throw new ArgumentNullException(nameof(overlayStateStore));
        _electronBridgeClient = electronBridgeClient;
        _viewModel = new ErrorOverlayViewModel();
        _viewModel.DismissRequested += (_, _) =>
        {
            RequestHide(source: "overlay-ui");
        };
        _viewModel.ViewRequested += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "ekadoc://",
                    UseShellExecute = true,
                });
            }
            catch
            {
                // best-effort
            }

            RequestHide(source: "overlay-ui");
        };

        InitializeComponent();
        DataContext = _viewModel;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        PillClipHost.SizeChanged += (_, _) => UpdatePillClip();
        Loaded += (_, _) =>
        {
            UpdatePillClip();
            PositionTopCenter();
        };
        SizeChanged += (_, _) => PositionTopCenter();
    }

    private void RequestHide(string source)
    {
        try { _overlayStateStore.Set(null, source: source); } catch { /* best-effort */ }
        try { HideOverlayAnimated(); } catch { /* best-effort */ }
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

        PillClipHost.Clip = new RectangleGeometry(new Rect(0, 0, w, h), PillCornerRadius, PillCornerRadius);
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

    internal void ShowOverlayAnimated(string? message)
    {
        _isShown = true;
        _viewModel.SetMessage(message);

        if (!IsVisible) Show();
        PositionTopCenter();
        _viewModel.StartCountdown(TimeSpan.FromSeconds(10));

        if (TryFindResource("OverlayShowStoryboard") is Storyboard sb)
        {
            sb.Stop(this);
            sb.Begin(this, true);
        }
    }

    internal void HideOverlayAnimated()
    {
        if (!_isShown && !IsVisible) return;

        _isShown = false;
        _viewModel.StopCountdown();

        if (TryFindResource("OverlayHideStoryboard") is not Storyboard sb)
        {
            Hide();
            return;
        }

        sb.Stop(this);
        sb.Completed -= OnHideStoryboardCompleted;
        sb.Completed += OnHideStoryboardCompleted;
        sb.Begin(this, true);
    }

    private void CloseOverlayButton_Click(object sender, RoutedEventArgs e)
    {
        RequestHide(source: "overlay-ui");
    }

    private void OnHideStoryboardCompleted(object? sender, EventArgs e)
    {
        if (_isShown) return;
        Hide();
    }

    private void PositionTopCenter()
    {
        OverlayPositioning.ApplyStoredOrTopCenter(this, topPadding: 12.0);
    }

    private void DragHandle_MouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        => OverlayWindowHelper.HandleDragMouseDown(this, _layoutStore);

    private void LogoButton_Click(object sender, RoutedEventArgs e)
        => OverlayWindowHelper.HandleLogoClick(_electronBridgeClient);

    private void OrientationToggle_Click(object sender, RoutedEventArgs e)
        => OverlayWindowHelper.HandleOrientationToggle(_layoutStore);

    internal static class NativeMethods
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        internal static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    }
}
