using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Threading;
using System.Diagnostics;
using EkaDeskDocHelper.Services;
using EkaDeskDocHelper.ViewModels;

namespace EkaDeskDocHelper
{
    /// <summary>
    /// Interaction logic for MainWindow.xaml
    /// </summary>
    public partial class MainWindow : Window
    {
        private const int NativeEventCooldownMs = 600;
        private bool _isShown;
        private readonly IOverlayStateStore _overlayStateStore;
        private readonly IElectronBridgeClient? _electronBridgeClient;
        private readonly IOverlayShortcutPreferencesStore? _shortcutPreferencesStore;
        private readonly PromptOverlayViewModel _viewModel;
        private DateTime _lastStartSentAtUtc = DateTime.MinValue;
        private const string StartRecordingDeepLink = "ekadoc://recording?command=start-recording&source=overlay";
        private const int HotkeyIdStartRecording = 0x0E5A;
        private const int HotkeyIdPauseResumeRecording = 0x0E5B;
        private const string PauseResumeShortcut = "Alt + P";
        private const int WmHotkey = 0x0312;
        private IntPtr _windowHandle = IntPtr.Zero;
        private HwndSource? _hwndSource;
        private bool _isStartHotkeyRegistered;
        private bool _isPauseResumeHotkeyRegistered;
        private ShortcutBinding _activeShortcutBinding;
        private ShortcutBinding _activePauseResumeShortcutBinding;
        private enum ScribeStatusKind
        {
            Unknown = 0,
            NotStarted = 1,
            Ready = 2,
            Recording = 3,
            Paused = 4,
            Analyzing = 5,
            OutputGenerated = 6,
            AnalyzingFailed = 7,
            Initializing = 8,
        }

        private enum ShortcutAction
        {
            None = 0,
            Start = 1,
            Stop = 2,
        }

        internal MainWindow(
            IOverlayStateStore overlayStateStore,
            IElectronBridgeClient? electronBridgeClient = null,
            IOverlayShortcutPreferencesStore? shortcutPreferencesStore = null)
        {
            _overlayStateStore = overlayStateStore ?? throw new ArgumentNullException(nameof(overlayStateStore));
            _electronBridgeClient = electronBridgeClient;
            _shortcutPreferencesStore = shortcutPreferencesStore;
            if (_shortcutPreferencesStore != null)
            {
                _shortcutPreferencesStore.Changed += OnShortcutPreferencesChanged;
            }
            _viewModel = new PromptOverlayViewModel();
            _viewModel.DismissRequested += (_, _) =>
            {
                MicrophoneMonitorService.Instance.NotifyPromptDismissed(_overlayStateStore.PromptTriggeringApp);
                _overlayStateStore.Set(null, source: "overlay-ui");
            };
            _viewModel.StartRequested += async (_, _) =>
            {
                // WPF is UI + intent only; Electron is source-of-truth for recording.
                try
                {
                    if (DateTime.UtcNow - _lastStartSentAtUtc < TimeSpan.FromMilliseconds(NativeEventCooldownMs))
                    {
                        Console.WriteLine("[OverlayUI] skipping duplicate start click");
                        return;
                    }

                    MicrophoneMonitorService.Instance.NotifyStartRequested();
                    _lastStartSentAtUtc = DateTime.UtcNow;
                    if (_electronBridgeClient?.IsConnected == true)
                    {
                        await _electronBridgeClient.SendEventAsync("recording.start", payload: null, CancellationToken.None);
                    }
                    else
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = StartRecordingDeepLink,
                            UseShellExecute = true,
                        });
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[OverlayUI] failed to trigger recording start: {ex.Message}");
                }
                finally
                {
                    // Dismiss the prompt overlay immediately on Start.
                    MicrophoneMonitorService.Instance.NotifyPromptDismissed(_overlayStateStore.PromptTriggeringApp);
                    _overlayStateStore.Set(null, source: "overlay-ui");
                }
            };

            InitializeComponent();
            _ = new WindowInteropHelper(this).EnsureHandle();
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

        private const double PillCornerRadius = 16;

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
            // Optional: remove from Alt+Tab
            _windowHandle = new WindowInteropHelper(this).Handle;
            const int GWL_EXSTYLE = -20;
            const int WS_EX_TOOLWINDOW = 0x00000080;
            const int WS_EX_APPWINDOW = 0x00040000;
            var exStyle = NativeMethods.GetWindowLong(_windowHandle, GWL_EXSTYLE);
            exStyle &= ~WS_EX_APPWINDOW;
            exStyle |= WS_EX_TOOLWINDOW;
            NativeMethods.SetWindowLong(_windowHandle, GWL_EXSTYLE, exStyle);

            _hwndSource = HwndSource.FromHwnd(_windowHandle);
            _hwndSource?.AddHook(WndProc);
            RegisterStartHotkey();
            RegisterPauseResumeHotkey();
        }

        internal void ShowOverlayAnimated(string? appName = null)
        {
            _viewModel.TriggeringAppName = appName;

            if (_isShown && IsVisible) return;

            _isShown = true;

            if (!IsVisible)
                Show();

            PositionTopCenter();
            _viewModel.StartCountdown(TimeSpan.FromSeconds(30));

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
            try
            {
                MicrophoneMonitorService.Instance.NotifyPromptDismissed(_overlayStateStore.PromptTriggeringApp);
                _overlayStateStore.Set(null, source: "overlay-ui");
            }
            catch { /* best-effort */ }
            try { HideOverlayAnimated(); } catch { /* best-effort */ }
        }

        protected override void OnClosed(EventArgs e)
        {
            UnregisterStartHotkey();
            UnregisterPauseResumeHotkey();
            if (_shortcutPreferencesStore != null)
            {
                _shortcutPreferencesStore.Changed -= OnShortcutPreferencesChanged;
            }
            if (_hwndSource != null)
            {
                _hwndSource.RemoveHook(WndProc);
                _hwndSource = null;
            }
            _windowHandle = IntPtr.Zero;
            base.OnClosed(e);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WmHotkey && wParam.ToInt32() == HotkeyIdStartRecording)
            {
                Console.WriteLine($"[OverlayUI] WM_HOTKEY received for {_activeShortcutBinding.NormalizedDisplay}");
                handled = true;
                _ = HandleStartShortcutAsync();
            }
            else if (msg == WmHotkey && wParam.ToInt32() == HotkeyIdPauseResumeRecording)
            {
                Console.WriteLine($"[OverlayUI] WM_HOTKEY received for {_activePauseResumeShortcutBinding.NormalizedDisplay}");
                handled = true;
                _ = HandlePauseResumeShortcutAsync();
            }

            return IntPtr.Zero;
        }

        private async Task HandleStartShortcutAsync()
        {
            var (action, currentStatus) = await ResolveShortcutActionAsync();
            if (action == ShortcutAction.None)
            {
                Console.WriteLine($"[OverlayUI] skipping hotkey because status is {currentStatus}");
                return;
            }

            if (action == ShortcutAction.Stop)
            {
                if (ShortcutRecordingDebounce.ShouldIgnoreStop())
                {
                    Console.WriteLine("[OverlayUI] ignoring shortcut stop within debounce window");
                    return;
                }

                ShortcutRecordingDebounce.Clear();
                await SendStopRecordingAsync();
                return;
            }

            ShortcutRecordingDebounce.MarkStarted();
            if (_viewModel.StartCommand.CanExecute(null))
            {
                _viewModel.StartCommand.Execute(null);
            }
        }

        private void RegisterStartHotkey()
        {
            if (_windowHandle == IntPtr.Zero) return;
            if (_isStartHotkeyRegistered) return;

            var prefs = _shortcutPreferencesStore?.Current ?? OverlayShortcutPreferences.Defaults();
            if (!prefs.Enabled)
            {
                Console.WriteLine("[OverlayUI] quick access shortcut disabled; skipping registration");
                return;
            }

            if (!ShortcutBindingParser.TryParse(prefs.Shortcut, out var binding))
            {
                Console.WriteLine($"[OverlayUI] failed to parse shortcut '{prefs.Shortcut}'; falling back to default '{OverlayShortcutPreferences.DefaultShortcut}'");
                if (!ShortcutBindingParser.TryParse(OverlayShortcutPreferences.DefaultShortcut, out binding))
                {
                    Console.WriteLine("[OverlayUI] default shortcut failed to parse; hotkey will not be registered");
                    return;
                }
            }

            _isStartHotkeyRegistered = NativeMethods.RegisterHotKey(
                _windowHandle,
                HotkeyIdStartRecording,
                binding.Modifiers,
                binding.VirtualKey);

            if (!_isStartHotkeyRegistered)
            {
                var lastError = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                Console.WriteLine($"[OverlayUI] failed to register global hotkey {binding.NormalizedDisplay}. win32={lastError}");
                return;
            }

            _activeShortcutBinding = binding;
            Console.WriteLine($"[OverlayUI] registered global hotkey {binding.NormalizedDisplay}");
        }

        private void UnregisterStartHotkey()
        {
            if (_windowHandle == IntPtr.Zero || !_isStartHotkeyRegistered)
            {
                return;
            }

            NativeMethods.UnregisterHotKey(_windowHandle, HotkeyIdStartRecording);
            _isStartHotkeyRegistered = false;
            Console.WriteLine($"[OverlayUI] unregistered global hotkey {_activeShortcutBinding.NormalizedDisplay}");
            _activeShortcutBinding = default;
        }

        private void RegisterPauseResumeHotkey()
        {
            if (_windowHandle == IntPtr.Zero) return;
            if (_isPauseResumeHotkeyRegistered) return;

            if (!ShortcutBindingParser.TryParse(PauseResumeShortcut, out var binding))
            {
                Console.WriteLine($"[OverlayUI] failed to parse pause/resume shortcut '{PauseResumeShortcut}'");
                return;
            }

            _isPauseResumeHotkeyRegistered = NativeMethods.RegisterHotKey(
                _windowHandle,
                HotkeyIdPauseResumeRecording,
                binding.Modifiers,
                binding.VirtualKey);

            if (!_isPauseResumeHotkeyRegistered)
            {
                var lastError = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                Console.WriteLine($"[OverlayUI] failed to register pause/resume hotkey {binding.NormalizedDisplay}. win32={lastError}");
                return;
            }

            _activePauseResumeShortcutBinding = binding;
            Console.WriteLine($"[OverlayUI] registered pause/resume hotkey {binding.NormalizedDisplay}");
        }

        private void UnregisterPauseResumeHotkey()
        {
            if (_windowHandle == IntPtr.Zero || !_isPauseResumeHotkeyRegistered)
            {
                return;
            }

            NativeMethods.UnregisterHotKey(_windowHandle, HotkeyIdPauseResumeRecording);
            _isPauseResumeHotkeyRegistered = false;
            Console.WriteLine($"[OverlayUI] unregistered pause/resume hotkey {_activePauseResumeShortcutBinding.NormalizedDisplay}");
            _activePauseResumeShortcutBinding = default;
        }

        private async Task HandlePauseResumeShortcutAsync()
        {
            if (_electronBridgeClient?.IsConnected != true)
            {
                Console.WriteLine("[OverlayUI] skipping pause/resume hotkey because bridge is disconnected");
                return;
            }

            try
            {
                var result = await _electronBridgeClient.SendRequestAsync(
                    "scribe.getStatus",
                    payload: null,
                    timeout: TimeSpan.FromSeconds(2),
                    cancellationToken: CancellationToken.None);

                if (!result.HasValue || !result.Value.TryGetProperty("processingStatus", out var statusProp))
                {
                    Console.WriteLine("[OverlayUI] skipping pause/resume hotkey because status is unavailable");
                    return;
                }

                var normalizedStatus = NormalizeStatus(statusProp.GetString());
                if (normalizedStatus == ScribeStatusKind.Paused)
                {
                    await _electronBridgeClient.SendEventAsync("recording.resume", payload: null, CancellationToken.None);
                    return;
                }

                if (normalizedStatus == ScribeStatusKind.Recording)
                {
                    await _electronBridgeClient.SendEventAsync("recording.pause", payload: null, CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to trigger pause/resume hotkey: {ex.Message}");
            }
        }

        private void OnShortcutPreferencesChanged(object? sender, OverlayShortcutPreferencesChangedEventArgs e)
        {
            // Re-registering a global hotkey must happen on the UI thread that
            // owns the window handle; hop via Dispatcher and never block.
            _ = Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    UnregisterStartHotkey();
                    RegisterStartHotkey();
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[OverlayUI] re-register hotkey failed: {ex.Message}");
                }
            }));
        }

        private async Task SendStopRecordingAsync()
        {
            try
            {
                if (_electronBridgeClient?.IsConnected != true)
                {
                    Console.WriteLine("[OverlayUI] skipping stop hotkey because bridge is disconnected");
                    return;
                }

                await _electronBridgeClient.SendEventAsync("recording.stop", payload: null, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to trigger recording stop: {ex.Message}");
            }
        }

        private async Task<(ShortcutAction Action, ScribeStatusKind Status)> ResolveShortcutActionAsync()
        {
            if (_electronBridgeClient?.IsConnected != true)
            {
                return (ShortcutAction.Start, ScribeStatusKind.Unknown);
            }

            try
            {
                var result = await _electronBridgeClient.SendRequestAsync(
                    "scribe.getStatus",
                    payload: null,
                    timeout: TimeSpan.FromSeconds(2),
                    cancellationToken: CancellationToken.None);

                if (!result.HasValue || !result.Value.TryGetProperty("processingStatus", out var statusProp))
                {
                    return (ShortcutAction.None, ScribeStatusKind.Unknown);
                }

                var normalizedStatus = NormalizeStatus(statusProp.GetString());
                var action = normalizedStatus switch
                {
                    ScribeStatusKind.Recording or ScribeStatusKind.Paused => ShortcutAction.Stop,
                    ScribeStatusKind.NotStarted or ScribeStatusKind.Ready or ScribeStatusKind.Unknown => ShortcutAction.Start,
                    _ => ShortcutAction.None,
                };

                Console.WriteLine($"[OverlayUI] Alt+S status check: {normalizedStatus} (action={action})");
                return (action, normalizedStatus);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to request scribe.getStatus before Alt+S: {ex.Message}");
                return (ShortcutAction.None, ScribeStatusKind.Unknown);
            }
        }

        private static ScribeStatusKind NormalizeStatus(string? status)
        {
            if (string.IsNullOrWhiteSpace(status)) return ScribeStatusKind.Unknown;

            var normalized = status.Trim().Replace('-', '_').ToUpperInvariant();
            return normalized switch
            {
                "NOT_STARTED" => ScribeStatusKind.NotStarted,
                "READY" => ScribeStatusKind.Ready,
                "PAUSED" or "RECORDING_PAUSED" => ScribeStatusKind.Paused,
                "RECORDING" or "RECORDING_STARTED" or "STARTED" or "IN_PROGRESS" or "RUNNING" or "RESUME" or "RECORDING_RESUMED" or "RECORDING_STOPPED" => ScribeStatusKind.Recording,
                "ANALYZING" or "ANALYSING" or "PROCESSING" => ScribeStatusKind.Analyzing,
                "OUTPUT_GENERATED" => ScribeStatusKind.OutputGenerated,
                "ANALYZING_FAILED" => ScribeStatusKind.AnalyzingFailed,
                "INITIALIZING" => ScribeStatusKind.Initializing,
                _ => ScribeStatusKind.Ready,
            };
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

        private void LogoButton_Click(object sender, RoutedEventArgs e)
            => OverlayWindowHelper.HandleLogoClick(_electronBridgeClient);

        private void DropdownChevron_Click(object sender, RoutedEventArgs e)
        {
            var menu = new System.Windows.Controls.ContextMenu();
            var appName = _viewModel.TriggeringAppName;
            if (!string.IsNullOrEmpty(appName))
            {
                var disableItem = new System.Windows.Controls.MenuItem { Header = $"Don't show for {appName}" };
                disableItem.Click += (_, _) =>
                {
                    DisabledAppsPreferencesStore.Instance.Disable(appName);
                    HideOverlayAnimated();
                    _overlayStateStore.Set(null, source: "overlay-ui");
                };
                menu.Items.Add(disableItem);
                menu.Items.Add(new System.Windows.Controls.Separator());
            }
            var resetItem = new System.Windows.Controls.MenuItem { Header = "Reset all disabled apps" };
            resetItem.Click += (_, _) => DisabledAppsPreferencesStore.Instance.ResetAll();
            menu.Items.Add(resetItem);
            menu.PlacementTarget = (UIElement)sender;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            menu.IsOpen = true;
        }

        internal static class NativeMethods
        {
            [System.Runtime.InteropServices.DllImport("user32.dll")]
            internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);
            [System.Runtime.InteropServices.DllImport("user32.dll")]
            internal static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
            [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
            [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
            internal static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
            [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
            [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
            internal static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        }
    }
}