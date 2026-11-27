import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { routesOffered, type InternetRoutes, type RouteName } from '@/remote/client';
import { colors, spacing } from '@/theme';

export const ROUTES: Record<RouteName, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  lan: { label: 'Local network', icon: 'wifi' },
  cloudflare: { label: 'Cloudflare', icon: 'cloud-outline' },
  ngrok: { label: 'ngrok', icon: 'globe-outline' },
};

/**
 * The way to reach a computer: the local network, or one of its ways in from
 * the Internet. Shown only when there is a choice; the user makes it.
 */
export function RoutePicker({ internet, value, onChange, label = 'Connect through', style }: {
  internet: InternetRoutes | undefined;
  value: RouteName;
  onChange: (route: RouteName) => void;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const routes = routesOffered(internet, value);
  if (routes.length < 2) return null;
  return (
    <View style={[styles.row, style]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips}>
        {routes.map((route) => {
          const selected = route === value;
          return (
            <Pressable
              key={route}
              onPress={() => onChange(route)}
              style={[styles.chip, selected && styles.chipActive]}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
            >
              <Ionicons name={ROUTES[route].icon} size={13} color={selected ? colors.accent : colors.textDim} />
              <Text style={[styles.chipText, selected && styles.chipTextActive]}>{ROUTES[route].label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 6 },
  label: { color: colors.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: 'rgba(128,136,255,0.18)', borderColor: colors.accent },
  chipText: { color: colors.textDim, fontSize: 13 },
  chipTextActive: { color: colors.text },
});
