using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Persisted layout for the floating overlay: where the user dragged it
    /// (top-left in WPF device-independent screen coordinates) and the
    /// recording-widget orientation. Anchoring by the top-left keeps the visual
    /// top consistent across differently-sized overlay states.
    /// </summary>
    internal sealed class OverlayLayoutPreferences
    {
        public const string OrientationHorizontal = "horizontal";
        public const string OrientationVertical = "vertical";

        [JsonPropertyName("hasCustomPosition")]
        public bool HasCustomPosition { get; set; }

        [JsonPropertyName("left")]
        public double Left { get; set; }

        [JsonPropertyName("top")]
        public double Top { get; set; }

        [JsonPropertyName("orientation")]
        public string Orientation { get; set; } = OrientationHorizontal;

        public bool IsVertical =>
            string.Equals(Orientation, OrientationVertical, StringComparison.OrdinalIgnoreCase);

        public static OverlayLayoutPreferences Defaults() => new();

        public OverlayLayoutPreferences Clone() => new()
        {
            HasCustomPosition = HasCustomPosition,
            Left = Left,
            Top = Top,
            Orientation = Orientation,
        };
    }

    internal interface IOverlayLayoutPreferencesStore
    {
        event EventHandler<OverlayLayoutPreferences>? Changed;
        OverlayLayoutPreferences Current { get; }
        void UpdatePosition(double left, double top);
        void UpdateOrientation(string orientation);
        void ToggleOrientation();
    }

    internal sealed class OverlayLayoutPreferencesStore : IOverlayLayoutPreferencesStore
    {
        private static readonly Lazy<OverlayLayoutPreferencesStore> LazyInstance =
            new(() => new OverlayLayoutPreferencesStore());

        public static OverlayLayoutPreferencesStore Instance => LazyInstance.Value;

        private readonly object _lock = new();
        private readonly string _filePath;
        private OverlayLayoutPreferences _current;

        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            WriteIndented = false,
        };

        public event EventHandler<OverlayLayoutPreferences>? Changed;

        public OverlayLayoutPreferencesStore(string? overrideFilePath = null)
        {
            _filePath = overrideFilePath ?? ResolveDefaultFilePath();
            _current = LoadFromDisk(_filePath) ?? OverlayLayoutPreferences.Defaults();
        }

        public OverlayLayoutPreferences Current
        {
            get
            {
                lock (_lock) return _current.Clone();
            }
        }

        public void UpdatePosition(double left, double top)
        {
            OverlayLayoutPreferences snapshot;
            lock (_lock)
            {
                if (_current.HasCustomPosition
                    && NearlyEqual(_current.Left, left)
                    && NearlyEqual(_current.Top, top))
                {
                    return;
                }

                _current.HasCustomPosition = true;
                _current.Left = left;
                _current.Top = top;
                TryPersist(_current, _filePath);
                snapshot = _current.Clone();
            }
            Changed?.Invoke(this, snapshot);
        }

        public void UpdateOrientation(string orientation)
        {
            var normalized = string.Equals(orientation, OverlayLayoutPreferences.OrientationVertical, StringComparison.OrdinalIgnoreCase)
                ? OverlayLayoutPreferences.OrientationVertical
                : OverlayLayoutPreferences.OrientationHorizontal;

            OverlayLayoutPreferences snapshot;
            lock (_lock)
            {
                if (string.Equals(_current.Orientation, normalized, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                _current.Orientation = normalized;
                TryPersist(_current, _filePath);
                snapshot = _current.Clone();
            }
            Changed?.Invoke(this, snapshot);
        }

        public void ToggleOrientation()
        {
            UpdateOrientation(Current.IsVertical
                ? OverlayLayoutPreferences.OrientationHorizontal
                : OverlayLayoutPreferences.OrientationVertical);
        }

        private static bool NearlyEqual(double a, double b) => Math.Abs(a - b) < 0.5;

        private static OverlayLayoutPreferences? LoadFromDisk(string filePath)
        {
            try
            {
                if (!File.Exists(filePath)) return null;
                var json = File.ReadAllText(filePath);
                if (string.IsNullOrWhiteSpace(json)) return null;
                var parsed = JsonSerializer.Deserialize<OverlayLayoutPreferences>(json, SerializerOptions);
                if (parsed == null) return null;
                if (string.IsNullOrWhiteSpace(parsed.Orientation))
                {
                    parsed.Orientation = OverlayLayoutPreferences.OrientationHorizontal;
                }
                return parsed;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OverlayLayoutPrefs] load failed: {ex.Message}");
                return null;
            }
        }

        private static void TryPersist(OverlayLayoutPreferences prefs, string filePath)
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
                Console.WriteLine($"[OverlayLayoutPrefs] persist failed: {ex.Message}");
            }
        }

        private static string ResolveDefaultFilePath()
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(root, "EkaDeskDocHelper", "layout-prefs.v1.json");
        }
    }
}
