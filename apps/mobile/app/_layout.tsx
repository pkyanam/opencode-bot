import { Stack } from "expo-router";
import { colors } from "../src/ui";
import { StoreProvider } from "../src/store";
export default function Layout() {
  return (
    <StoreProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </StoreProvider>
  );
}
