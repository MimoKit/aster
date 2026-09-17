import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { Shell } from './components/Shell';
import { AppRoutes } from './routes';

import './styles/theme.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes>
        <Shell />
      </AppRoutes>
    </BrowserRouter>
  </StrictMode>,
);
