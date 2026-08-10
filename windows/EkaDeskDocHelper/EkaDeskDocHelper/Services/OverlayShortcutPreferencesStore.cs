using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Persisted user preferences for the global quick-access shortcut that
    /// triggers recording from anywhere on the desktop. The Settings UI in
    /// Electron is authoritative for user intent; this store persists the last
    /// synced values locally so the helper survives Electron restarts and can
    /// rehydrate Settings on the next open.
    /// </summary>
    internal sealed class OverlayShortcutPreferences
    {
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; } = true;

        [JsonPropertyName("shortcut")]
        public string Shortcut { get; set; } = DefaultShortcut;

        public const string DefaultShortcut = "Alt + S";

        public static OverlayShortcutPreferences Defaults() => new();

        public OverlayShortcutPreferences Clone() => new()
        {
            Enabled = Enabled,
            Shortcut = Shortcut,
        };
    }

    internal sealed class OverlayShortcutPreferencesChangedEventArgs : EventArgs
    {
        public OverlayShortcutPreferencesChangedEventArgs(OverlayShortcutPreferences previous, OverlayShortcutPreferences current)
        {
            Previous = previous;
            Current = current;
        }

        public OverlayShortcutPreferences Previous { get; }

        public OverlayShortcutPreferences Current { get; }
    }

    internal interface IOverlayShortcutPreferencesStore
    {
        event EventHandler<OverlayShortcutPreferencesChangedEventArgs>? Changed;
        OverlayShortcutPreferences Current { get; }
        OverlayShortcutPreferences Update(JsonElement? partial);
    }

    internal sealed class OverlayShortcutPreferencesStore : IOverlayShortcutPreferencesStore
    {
        private readonly object _lock = new();
        private readonly string _filePath;
        private OverlayShortcutPreferences _current;

        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            WriteIndented = false,
        };

        public event EventHandler<OverlayShortcutPreferencesChangedEventArgs>? Changed;

        public OverlayShortcutPreferencesStore(string? overrideFilePath = null)
        {
            _filePath = overrideFilePath ?? ResolveDefaultFilePath();
            _current = LoadFromDisk(_filePath) ?? OverlayShortcutPreferences.Defaults();
        }

        public OverlayShortcutPreferences Current
        {
            get
            {
                lock (_lock) return _current.Clone();
            }
        }

        public OverlayShortcutPreferences Update(JsonElement? partial)
        {
            OverlayShortcutPreferences previous;
            OverlayShortcutPreferences merged;
            lock (_lock)
            {
                previous = _current.Clone();
                merged = _current.Clone();
                ApplyPartial(merged, partial);
                _current = merged.Clone();
                TryPersist(_current, _filePath);
            }
            Changed?.Invoke(this, new OverlayShortcutPreferencesChangedEventArgs(previous, merged.Clone()));
            return merged;
        }

        private static void ApplyPartial(OverlayShortcutPreferences target, JsonElement? partial)
        {
            if (!partial.HasValue || partial.Value.ValueKind != JsonValueKind.Object) return;
            var obj = partial.Value;

            if (TryReadBool(obj, "enabled", out var enabled))
            {
                target.Enabled = enabled;
            }

            if (obj.TryGetProperty("shortcut", out var shortcut) && shortcut.ValueKind == JsonValueKind.String)
            {
                var value = shortcut.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    target.Shortcut = value.Trim();
                }
            }
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

        private static OverlayShortcutPreferences? LoadFromDisk(string filePath)
        {
            try
            {
                if (!File.Exists(filePath)) return null;
                var json = File.ReadAllText(filePath);
                if (string.IsNullOrWhiteSpace(json)) return null;
                var parsed = JsonSerializer.Deserialize<OverlayShortcutPreferences>(json, SerializerOptions);
                if (parsed == null) return null;
                if (string.IsNullOrWhiteSpace(parsed.Shortcut))
                {
                    parsed.Shortcut = OverlayShortcutPreferences.DefaultShortcut;
                }
                return parsed;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayShortcutPrefs] load failed: {ex.Message}");
                return null;
            }
        }

        private static void TryPersist(OverlayShortcutPreferences prefs, string filePath)
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
                Console.WriteLine($"[OverlayShortcutPrefs] persist failed: {ex.Message}");
            }
        }

        private static string ResolveDefaultFilePath()
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(root, "EkaDeskDocHelper", "shortcut-prefs.v1.json");
        }
    }
}
