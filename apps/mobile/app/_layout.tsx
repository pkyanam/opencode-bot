import { Stack } from "expo-router";
import { StoreProvider } from "../src/store";
export default function Layout() {
  return (
    <StoreProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#111313" },
        }}
      />
    </StoreProvider>
  );
}
