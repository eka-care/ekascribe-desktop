using System;
using System.Globalization;
using System.Windows.Data;

namespace EkaDeskDocHelper.Converters;

internal sealed class PercentToScaleConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not double pct) return 0d;
        if (double.IsNaN(pct) || double.IsInfinity(pct)) return 0d;
        return Math.Clamp(pct / 100d, 0d, 1d);
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

