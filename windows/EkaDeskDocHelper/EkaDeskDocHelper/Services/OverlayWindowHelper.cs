using System;
using System.Threading;
using System.Windows;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Shared handlers used by every overlay window that carries a drag handle,
    /// logo button, and orientation toggle.
    /// </summary>
    internal static class OverlayWindowHelper
    {
        /// <summary>
        /// Call from a <c>MouseLeftButtonDown</c> handler on the drag-handle border.
        /// Moves the window via <see cref="Window.DragMove"/>, then clamps and
        /// persists the final position.
        /// </summary>
        public static void HandleDragMouseDown(Window window, IOverlayLayoutPreferencesStore store)
        {
            try
            {
                window.DragMove();
            }
            catch (InvalidOperationException)
            {
                // DragMove throws if the button is no longer pressed when called.
            }
            finally
            {
                ClampAndPersist(window, store);
            }
        }

        /// <summary>
        /// Call from a logo <c>Click</c> handler to open / focus the main app.
        /// </summary>
        public static async void HandleLogoClick(IElectronBridgeClient? client)
        {
            try
            {
                if (client != null)
                {
                    await client.SendEventAsync("overlay.open.app", payload: null, CancellationToken.None);
                    Console.WriteLine("[OverlayUI] -> event overlay.open.app");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayUI] failed to send overlay.open.app: {ex.Message}");
            }
        }

        /// <summary>
        /// Call from an orientation-toggle <c>Click</c> handler.
        /// </summary>
        public static void HandleOrientationToggle(IOverlayLayoutPreferencesStore store)
        {
            store.ToggleOrientation();
        }

        private static void ClampAndPersist(Window window, IOverlayLayoutPreferencesStore store)
        {
            var (left, top) = OverlayPositioning.Clamp(window.Left, window.Top, window.ActualWidth, window.ActualHeight);
            window.Left = left;
            window.Top = top;
            store.UpdatePosition(left, top);
        }
    }
}
