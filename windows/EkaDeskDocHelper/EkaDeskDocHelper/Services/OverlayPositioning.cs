using System;
using System.Windows;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Shared geometry for placing overlay windows. Honors the user's dragged
    /// top-left anchor (so all overlay states appear in the same place) and
    /// keeps the window fully inside the work area.
    /// </summary>
    internal static class OverlayPositioning
    {
        public const double EdgeMargin = 8.0;

        /// <summary>
        /// Clamps a desired top-left so a window of <paramref name="width"/> x
        /// <paramref name="height"/> stays inside the primary work area, leaving
        /// a small margin. If the window is larger than the available area on an
        /// axis it is pinned to the min edge.
        /// </summary>
        public static (double left, double top) Clamp(double left, double top, double width, double height, double margin = EdgeMargin)
        {
            var workArea = SystemParameters.WorkArea;
            if (double.IsNaN(width) || width < 0) width = 0;
            if (double.IsNaN(height) || height < 0) height = 0;

            var minL = workArea.Left + margin;
            var maxL = workArea.Right - width - margin;
            var minT = workArea.Top + margin;
            var maxT = workArea.Bottom - height - margin;

            var clampedLeft = maxL >= minL ? Math.Min(Math.Max(left, minL), maxL) : minL;
            var clampedTop = maxT >= minT ? Math.Min(Math.Max(top, minT), maxT) : minT;
            return (clampedLeft, clampedTop);
        }

        /// <summary>
        /// Positions the window at the user's stored top-left (clamped) when a
        /// custom position exists, otherwise at the default top-center with the
        /// given top padding.
        /// </summary>
        public static void ApplyStoredOrTopCenter(Window window, double topPadding)
        {
            var workArea = SystemParameters.WorkArea;
            if (double.IsNaN(window.ActualWidth) || window.ActualWidth <= 0)
            {
                window.UpdateLayout();
            }

            var width = window.ActualWidth > 0 ? window.ActualWidth : window.Width;
            var height = window.ActualHeight > 0 ? window.ActualHeight : window.Height;

            var prefs = OverlayLayoutPreferencesStore.Instance.Current;
            if (prefs.HasCustomPosition)
            {
                var (left, top) = Clamp(prefs.Left, prefs.Top, width, height);
                window.Left = left;
                window.Top = top;
                return;
            }

            window.Left = workArea.Left + (workArea.Width - width) / 2.0;
            window.Top = workArea.Top + topPadding;
        }
    }
}
