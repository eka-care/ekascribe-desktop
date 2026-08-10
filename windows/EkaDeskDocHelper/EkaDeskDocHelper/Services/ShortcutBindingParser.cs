using System;
using System.Collections.Generic;

namespace EkaDeskDocHelper.Services
{
    /// <summary>
    /// Represents a parsed Windows hotkey binding in the shape expected by
    /// <c>RegisterHotKey</c>: a combination of modifier flags and a virtual-key.
    /// </summary>
    internal readonly record struct ShortcutBinding(uint Modifiers, uint VirtualKey, string NormalizedDisplay);

    /// <summary>
    /// Parses the settings UI's shortcut strings ("Alt + S", "Ctrl + Shift + 1")
    /// into typed <see cref="ShortcutBinding"/> values. The Settings UI enforces
    /// "single modifier + one main key" today but the parser accepts multiple
    /// modifiers defensively in case the contract ever widens.
    /// </summary>
    internal static class ShortcutBindingParser
    {
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;

        private static readonly Dictionary<string, uint> ModifierMap = new(StringComparer.OrdinalIgnoreCase)
        {
            { "Alt", ModAlt },
            { "Option", ModAlt },
            { "Ctrl", ModControl },
            { "Control", ModControl },
            { "Shift", ModShift },
            { "Cmd", ModWin },
            { "Command", ModWin },
            { "Win", ModWin },
            { "Super", ModWin },
            { "Meta", ModWin },
        };

        private static readonly Dictionary<string, uint> NamedKeyMap = new(StringComparer.OrdinalIgnoreCase)
        {
            { "Space", 0x20 },
            { "Tab", 0x09 },
            { "Enter", 0x0D },
            { "Return", 0x0D },
            { "Backspace", 0x08 },
            { "Delete", 0x2E },
            { "Insert", 0x2D },
            { "Escape", 0x1B },
            { "Esc", 0x1B },
            { "Home", 0x24 },
            { "End", 0x23 },
            { "PageUp", 0x21 },
            { "PageDown", 0x22 },
            { "Left", 0x25 },
            { "Up", 0x26 },
            { "Right", 0x27 },
            { "Down", 0x28 },
            { "-", 0xBD },
            { "=", 0xBB },
            { "[", 0xDB },
            { "]", 0xDD },
            { "\\", 0xDC },
            { ";", 0xBA },
            { "'", 0xDE },
            { "`", 0xC0 },
            { ",", 0xBC },
            { ".", 0xBE },
            { "/", 0xBF },
        };

        public static bool TryParse(string? input, out ShortcutBinding binding)
        {
            binding = default;
            if (string.IsNullOrWhiteSpace(input)) return false;

            var tokens = input.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (tokens.Length < 2) return false;

            uint modifiers = 0;
            uint? virtualKey = null;
            var normalizedParts = new List<string>();

            for (var index = 0; index < tokens.Length; index++)
            {
                var token = tokens[index];
                if (ModifierMap.TryGetValue(token, out var modifier))
                {
                    if ((modifiers & modifier) != 0) return false; // duplicate modifier
                    modifiers |= modifier;
                    normalizedParts.Add(DisplayNameForModifier(modifier));
                    continue;
                }

                if (virtualKey.HasValue)
                {
                    // More than one non-modifier token is not a valid binding.
                    return false;
                }

                if (!TryParseMainKey(token, out var resolvedKey, out var normalized))
                {
                    return false;
                }
                virtualKey = resolvedKey;
                normalizedParts.Add(normalized);
            }

            if (modifiers == 0 || !virtualKey.HasValue) return false;

            binding = new ShortcutBinding(modifiers, virtualKey.Value, string.Join(" + ", normalizedParts));
            return true;
        }

        private static bool TryParseMainKey(string token, out uint virtualKey, out string normalized)
        {
            virtualKey = 0;
            normalized = token;

            if (token.Length == 1)
            {
                var ch = char.ToUpperInvariant(token[0]);
                if (ch >= 'A' && ch <= 'Z')
                {
                    virtualKey = (uint)ch;
                    normalized = ch.ToString();
                    return true;
                }
                if (ch >= '0' && ch <= '9')
                {
                    virtualKey = (uint)ch;
                    normalized = ch.ToString();
                    return true;
                }
            }

            if (token.Length >= 2 && (token[0] == 'F' || token[0] == 'f') && int.TryParse(token.AsSpan(1), out var fn))
            {
                if (fn >= 1 && fn <= 24)
                {
                    virtualKey = (uint)(0x70 + (fn - 1)); // VK_F1 = 0x70
                    normalized = $"F{fn}";
                    return true;
                }
            }

            if (NamedKeyMap.TryGetValue(token, out var mapped))
            {
                virtualKey = mapped;
                normalized = CanonicalNamedKey(token);
                return true;
            }

            return false;
        }

        private static string DisplayNameForModifier(uint modifier) => modifier switch
        {
            ModAlt => "Alt",
            ModControl => "Ctrl",
            ModShift => "Shift",
            ModWin => "Win",
            _ => modifier.ToString(),
        };

        private static string CanonicalNamedKey(string token)
        {
            return token.Length == 1 ? token : char.ToUpperInvariant(token[0]) + token.Substring(1);
        }
    }
}
