using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace EkaDeskDocHelper.Services;

internal interface IDisabledAppsPreferencesStore
{
    bool IsDisabled(string appName);
    void Disable(string appName);
    void ResetAll();
}

internal sealed class DisabledAppsPreferencesStore : IDisabledAppsPreferencesStore
{
    public static readonly DisabledAppsPreferencesStore Instance = new();

    private readonly object _lock = new();
    private readonly string _filePath;
    private HashSet<string> _disabled;

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };

    private DisabledAppsPreferencesStore()
    {
        _filePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EkaDeskDocHelper",
            "disabled-apps.v1.json");
        _disabled = Load(_filePath);
    }

    public bool IsDisabled(string appName)
    {
        if (string.IsNullOrWhiteSpace(appName)) return false;
        lock (_lock) { return _disabled.Contains(appName); }
    }

    public void Disable(string appName)
    {
        if (string.IsNullOrWhiteSpace(appName)) return;
        lock (_lock)
        {
            _disabled.Add(appName);
            Save(_filePath, _disabled);
        }
        Console.WriteLine($"[DisabledApps] disabled prompt for app: {appName}");
    }

    public void ResetAll()
    {
        lock (_lock)
        {
            _disabled.Clear();
            Save(_filePath, _disabled);
        }
        Console.WriteLine("[DisabledApps] reset all disabled apps");
    }

    private static HashSet<string> Load(string path)
    {
        try
        {
            if (!File.Exists(path)) return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var json = File.ReadAllText(path);
            var list = JsonSerializer.Deserialize<List<string>>(json);
            return list == null
                ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(list, StringComparer.OrdinalIgnoreCase);
        }
        catch { return new HashSet<string>(StringComparer.OrdinalIgnoreCase); }
    }

    private static void Save(string path, HashSet<string> apps)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(new List<string>(apps), JsonOptions));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[DisabledApps] failed to save: {ex.Message}");
        }
    }
}
