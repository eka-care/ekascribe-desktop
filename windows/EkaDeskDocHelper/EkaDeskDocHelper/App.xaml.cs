using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using EkaDeskDocHelper.Services;

namespace EkaDeskDocHelper
{
    /// <summary>
    /// Interaction logic for App.xaml
    /// </summary>
    public partial class App : Application
    {
        private const string SingleInstanceMutexName = @"Local\EkaDeskDocHelper.SingleInstance";
        private Mutex? _singleInstanceMutex;
        private IOverlayStateStore? _overlayStateStore;
        private OverlayWindowController? _overlayWindowController;
        private IOverlayNotificationPreferencesStore? _overlayPreferencesStore;
        private IOverlayShortcutPreferencesStore? _overlayShortcutPreferencesStore;

        protected override void OnStartup(StartupEventArgs e)
        {
            // Stdio transport requires capturing the raw stdout pipe BEFORE
            // any logging touches it, then rerouting Console.Out to stderr so
            // existing diagnostic writes never corrupt the framed channel.
            var useStdioBridge = ElectronBridgeService.HasBridgeStdioFlag(e.Args);
            Stream? bridgeStdin = null;
            Stream? bridgeStdout = null;
            if (useStdioBridge)
            {
                bridgeStdin = Console.OpenStandardInput();
                bridgeStdout = Console.OpenStandardOutput();
                try
                {
                    var stderrWriter = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true };
                    Console.SetOut(stderrWriter);
                }
                catch
                {
                    // best-effort: if we can't redirect, fall through; the
                    // bridge writes go through bridgeStdout directly anyway.
                }
            }

            //EnsureDebugConsole();

            Console.WriteLine("EkaDeskDocHelper: starting up.");

            if (!TryAcquireSingleInstanceMutex())
            {
                Console.WriteLine("EkaDeskDocHelper: instance already running, exiting.");
                Shutdown();
                return;
            }

            ShutdownMode = ShutdownMode.OnExplicitShutdown;

            _overlayStateStore = OverlayStateStore.Instance;
            _overlayPreferencesStore = new OverlayNotificationPreferencesStore();
            _overlayPreferencesStore.Changed += OnOverlayPreferencesChanged;
            _overlayShortcutPreferencesStore = new OverlayShortcutPreferencesStore();

            if (useStdioBridge && bridgeStdin != null && bridgeStdout != null)
            {
                Console.WriteLine("Bridge target: stdio (parent process pipes)");
                ElectronBridgeService.Instance.InitializeStdio(
                    bridgeStdin,
                    bridgeStdout,
                    _overlayStateStore,
                    HandleElectronRequestAsync);
            }
            else
            {
                var bridgeHost = ElectronBridgeService.TryGetBridgeHost(e.Args) ?? "127.0.0.1";
                var bridgePort = ElectronBridgeService.TryGetBridgePort(e.Args) ?? 50505;
                Console.WriteLine($"Bridge target: {bridgeHost}:{bridgePort}");
                ElectronBridgeService.Instance.Initialize(
                    bridgeHost,
                    bridgePort,
                    _overlayStateStore,
                    HandleElectronRequestAsync);
            }
            _ = ElectronBridgeService.Instance.StartAsync();

            _overlayWindowController = new OverlayWindowController(
                Dispatcher,
                _overlayStateStore,
                ElectronBridgeService.Instance.Client,
                _overlayShortcutPreferencesStore);
            ElectronBridgeService.Instance.AttachOverlayController(_overlayWindowController);

            MicrophoneMonitorService.Instance.Initialize(
                new MicrophoneUsageMonitor(),
                ElectronBridgeService.Instance.Client,
                _overlayStateStore,
                _overlayPreferencesStore);
            MicrophoneMonitorService.Instance.Start();
        }

        private Task<object?> HandleElectronRequestAsync(string name, JsonElement? payload)
        {
            Console.WriteLine($"[App] <- request {name}");
            switch (name)
            {
                case "overlay.notificationPrefs.get":
                {
                    var prefs = _overlayPreferencesStore?.Current ?? OverlayNotificationPreferences.Defaults();
                    return Task.FromResult<object?>(prefs);
                }
                case "overlay.notificationPrefs.update":
                {
                    if (_overlayPreferencesStore == null)
                    {
                        return Task.FromResult<object?>(OverlayNotificationPreferences.Defaults());
                    }
                    var updated = _overlayPreferencesStore.Update(payload);
                    Console.WriteLine($"[App] notification prefs updated join={updated.JoinVideoConferencingAndStartTranscribing} rec={updated.MeetingIsBeingRecorded} sum={updated.MeetingIsSummarized}");
                    return Task.FromResult<object?>(updated);
                }
                case "overlay.shortcut.get":
                {
                    var prefs = _overlayShortcutPreferencesStore?.Current ?? OverlayShortcutPreferences.Defaults();
                    Console.WriteLine($"[App] shortcut prefs requested enabled={prefs.Enabled} shortcut={prefs.Shortcut}");
                    return Task.FromResult<object?>(prefs);
                }
                case "overlay.shortcut.update":
                {
                    if (_overlayShortcutPreferencesStore == null)
                    {
                        return Task.FromResult<object?>(OverlayShortcutPreferences.Defaults());
                    }
                    var updated = _overlayShortcutPreferencesStore.Update(payload);
                    Console.WriteLine($"[App] shortcut prefs updated enabled={updated.Enabled} shortcut={updated.Shortcut}");
                    return Task.FromResult<object?>(updated);
                }
                default:
                    throw new InvalidOperationException($"Unknown request: {name}");
            }
        }

        private void OnOverlayPreferencesChanged(object? sender, OverlayNotificationPreferences prefs)
        {
            try
            {
                Console.WriteLine($"[App] overlay prefs changed: join={prefs.JoinVideoConferencingAndStartTranscribing} rec={prefs.MeetingIsBeingRecorded} sum={prefs.MeetingIsSummarized}");
                // If any preference is disabled while its overlay is visible,
                // hide it immediately so the UI reflects the new preference
                // without waiting for the next scribe/mic event. Future events
                // will re-drive overlays according to the latest prefs.
                if (!prefs.JoinVideoConferencingAndStartTranscribing)
                {
                    _overlayStateStore?.Set(null, source: "notification-prefs");
                }
                if (!prefs.MeetingIsBeingRecorded || !prefs.MeetingIsSummarized)
                {
                    _overlayStateStore?.Set(null, source: "notification-prefs");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[App] OnOverlayPreferencesChanged failed: {ex.Message}");
            }
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try { MicrophoneMonitorService.Instance.Dispose(); } catch { /* best-effort */ }
            try { _overlayWindowController?.Dispose(); } catch { /* best-effort */ }
            try { _ = ElectronBridgeService.Instance.DisposeAsync(); } catch { /* best-effort */ }
            try { _singleInstanceMutex?.ReleaseMutex(); } catch { /* best-effort */ }
            try { _singleInstanceMutex?.Dispose(); } catch { /* best-effort */ }
            if (_overlayPreferencesStore != null)
            {
                _overlayPreferencesStore.Changed -= OnOverlayPreferencesChanged;
            }
            _overlayWindowController = null;
            _overlayStateStore = null;
            _overlayPreferencesStore = null;
            _overlayShortcutPreferencesStore = null;
            _singleInstanceMutex = null;

            Console.WriteLine("EkaDeskDocHelper: exiting.");
            base.OnExit(e);
        }

        private bool TryAcquireSingleInstanceMutex()
        {
            try
            {
                _singleInstanceMutex = new Mutex(initiallyOwned: true, name: SingleInstanceMutexName, createdNew: out var createdNew);
                return createdNew;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"EkaDeskDocHelper: failed to acquire single-instance mutex: {ex.Message}");
                return false;
            }
        }

        private static void EnsureDebugConsole()
        {
#if DEBUG
            try
            {
                // If launched from a terminal, just attach to that console.
                // Otherwise create a new console window for live logs.
                if (GetConsoleWindow() == IntPtr.Zero)
                {
                    if (!AttachConsole(ATTACH_PARENT_PROCESS))
                    {
                        _ = AllocConsole();
                    }

                    var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
                    Console.SetOut(stdout);

                    var stderr = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true };
                    Console.SetError(stderr);
                }
            }
            catch
            {
                // best-effort; console is for debug visibility only
            }
#endif
        }

        private const int ATTACH_PARENT_PROCESS = -1;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AllocConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetConsoleWindow();
    }

}
