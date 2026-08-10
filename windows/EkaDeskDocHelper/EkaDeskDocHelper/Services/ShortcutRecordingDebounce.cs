using System;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Prevents the start/stop shortcut from stopping a recording within 5 seconds
    /// of being started by the same shortcut.
    /// </summary>
    internal static class ShortcutRecordingDebounce
    {
        public const int DebounceMs = 5000;
        private static DateTime? _startedAtUtc;

        public static void MarkStarted() => _startedAtUtc = DateTime.UtcNow;

        public static void Clear() => _startedAtUtc = null;

        public static bool ShouldIgnoreStop()
        {
            return _startedAtUtc.HasValue
                && DateTime.UtcNow - _startedAtUtc.Value < TimeSpan.FromMilliseconds(DebounceMs);
        }
    }
}
