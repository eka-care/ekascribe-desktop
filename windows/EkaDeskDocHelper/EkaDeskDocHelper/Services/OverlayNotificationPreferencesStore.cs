using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Persisted user preferences controlling which overlay categories the
    /// helper is permitted to display. Mirrors the shared
    /// <c>OverlayNotificationPreferences</c> contract with Electron.
    /// </summary>
    internal sealed class OverlayNotificationPreferences
    {
        [JsonPropertyName("joinVideoConferencingAndStartTranscribing")]
        public bool JoinVideoConferencingAndStartTranscribing { get; set; } = true;

        [JsonPropertyName("meetingIsBeingRecorded")]
        public bool MeetingIsBeingRecorded { get; set; } = true;

        [JsonPropertyName("meetingIsSummarized")]
        public bool MeetingIsSummarized { get; set; } = true;

        public static OverlayNotificationPreferences Defaults() => new();

        public OverlayNotificationPreferences Clone() => new()
        {
            JoinVideoConferencingAndStartTranscribing = JoinVideoConferencingAndStartTranscribing,
            MeetingIsBeingRecorded = MeetingIsBeingRecorded,
            MeetingIsSummarized = MeetingIsSummarized,
        };
    }

    internal interface IOverlayNotificationPreferencesStore
    {
        event EventHandler<OverlayNotificationPreferences>? Changed;
        OverlayNotificationPreferences Current { get; }
        OverlayNotificationPreferences Update(JsonElement? partial);
    }

    internal sealed class OverlayNotificationPreferencesStore : IOverlayNotificationPreferencesStore
    {
        private readonly object _lock = new();
        private readonly string _filePath;
        private OverlayNotificationPreferences _current;

        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            WriteIndented = false,
        };

        public event EventHandler<OverlayNotificationPreferences>? Changed;

        public OverlayNotificationPreferencesStore(string? overrideFilePath = null)
        {
            _filePath = overrideFilePath ?? ResolveDefaultFilePath();
            _current = LoadFromDisk(_filePath) ?? OverlayNotificationPreferences.Defaults();
        }

        public OverlayNotificationPreferences Current
        {
            get
            {
                lock (_lock) return _current.Clone();
            }
        }

        public OverlayNotificationPreferences Update(JsonElement? partial)
        {
            OverlayNotificationPreferences merged;
            lock (_lock)
            {
                merged = _current.Clone();
                ApplyPartial(merged, partial);
                _current = merged.Clone();
                TryPersist(_current, _filePath);
            }
            Changed?.Invoke(this, merged.Clone());
            return merged;
        }

        private static void ApplyPartial(OverlayNotificationPreferences target, JsonElement? partial)
        {
            if (!partial.HasValue || partial.Value.ValueKind != JsonValueKind.Object) return;
            var obj = partial.Value;

            if (TryReadBool(obj, "joinVideoConferencingAndStartTranscribing", out var join))
                target.JoinVideoConferencingAndStartTranscribing = join;
            if (TryReadBool(obj, "meetingIsBeingRecorded", out var recording))
                target.MeetingIsBeingRecorded = recording;
            if (TryReadBool(obj, "meetingIsSummarized", out var summarized))
                target.MeetingIsSummarized = summarized;
        }

        private static bool TryReadBool(JsonElement obj, string name, out bool value)
        {
            value = false;
            if (!obj.TryGetProperty(name, out var el)) return false;
            switch (el.ValueKind)
            {
                case JsonValueKind.True: value = true; return true;
                case JsonValueKind.False: value = false; return true;
                case JsonValueKind.Number:
                    if (el.TryGetInt32(out var n))
                    {
                        if (n == 1) { value = true; return true; }
                        if (n == 0) { value = false; return true; }
                    }
                    return false;
                case JsonValueKind.String:
                    var s = el.GetString()?.Trim();
                    if (string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) { value = true; return true; }
                    if (string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) { value = false; return true; }
                    return false;
                default:
                    return false;
            }
        }

        private static OverlayNotificationPreferences? LoadFromDisk(string filePath)
        {
            try
            {
                if (!File.Exists(filePath)) return null;
                var json = File.ReadAllText(filePath);
                if (string.IsNullOrWhiteSpace(json)) return null;
                return JsonSerializer.Deserialize<OverlayNotificationPreferences>(json, SerializerOptions);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayNotificationPrefs] load failed: {ex.Message}");
                return null;
            }
        }

        private static void TryPersist(OverlayNotificationPreferences prefs, string filePath)
        {
            try
            {
                var directory = Path.GetDirectoryName(filePath);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                var json = JsonSerializer.Serialize(prefs, SerializerOptions);
                File.WriteAllText(filePath, json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayNotificationPrefs] persist failed: {ex.Message}");
            }
        }

        private static string ResolveDefaultFilePath()
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(root, "EkaDeskDocHelper", "notification-prefs.v1.json");
        }
    }
}
