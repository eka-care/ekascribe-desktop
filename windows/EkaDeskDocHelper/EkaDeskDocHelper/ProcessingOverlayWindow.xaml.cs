using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media.Animation;
using EkaDeskDocHelper.Services;
using EkaDeskDocHelper.ViewModels;

namespace EkaDeskDocHelper;

public partial class ProcessingOverlayWindow : Window
{
    private bool _isShown;
    private readonly IElectronBridgeClient? _electronBridgeClient;
    private readonly IOverlayLayoutPreferencesStore _layoutStore = OverlayLayoutPreferencesStore.Instance;

    internal ProcessingOverlayWindow(IElectronBridgeClient? electronBridgeClient = null)
    {
        _electronBridgeClient = electronBridgeClient;
        InitializeComponent();
        DataContext = new ProcessingOverlayViewModel();
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Loaded += (_, _) => PositionTopCenter();
        SizeChanged += (_, _) => PositionTopCenter();
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
    }

    private void CloseOverlayButton_Click(object sender, RoutedEventArgs e)
    {
        try { HideOverlayAnimated(); } catch { /* best-effort */ }
        try { Hide(); } catch { /* best-effort */ }
        // Reset the scribe phase so the overlay does not re-appear on the next
        // RefreshOverlayVisibility() call while processing is still in flight.
        // Mirrors macOS BridgeAppState.dismissOverlayPrompt() handling of .processing.
        try { ElectronBridgeService.Instance.DismissProcessingOverlay(); } catch { /* best-effort */ }
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

    private void DragHandle_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
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
