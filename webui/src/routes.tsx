/** 路由表 */

import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { ConnectionsPage } from './pages/Connections';
import { ConsolePage } from './pages/Console';
import { LogsPage } from './pages/Logs';
import { MarketPage } from './pages/Market';
import { OverviewPage } from './pages/Overview';
import { PluginsPage } from './pages/Plugins';
import { SettingsPage } from './pages/Settings';

export function AppRoutes({ children }: { children: ReactNode }) {
  return (
    <Routes>
      <Route element={children}>
        <Route index element={<OverviewPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="plugins" element={<PluginsPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="console" element={<ConsolePage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
