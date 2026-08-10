import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { IndexPage } from './src/IndexPage';
import { HomePage } from './src/screens/home/homePage';
import { LoginPipView } from './src/screens/auth/LoginPipView';

function AppNavigator() {
  const navigate = useNavigate();

  React.useEffect(() => {
    const unsubEnter = window.loginPipApi.onEnter(() => {
      navigate('/login-pip/');
    });
    const unsubExit = window.loginPipApi.onExit((route) => {
      navigate(route ?? '/main/');
    });
    return () => {
      unsubEnter();
      unsubExit();
    };
  }, [navigate]);

  return null;
}

const App = () => {
  return (
    <HashRouter>
      <AppNavigator />
      <Routes>
        <Route path="/" element={<Navigate to="/main" replace />} />
        <Route path="/main/" element={<IndexPage />} />
        <Route path="/home/" element={<HomePage />} />
        <Route path="/login-pip/" element={<LoginPipView />} />
        <Route path="*" element={<Navigate to="/main" replace />} />
      </Routes>
    </HashRouter>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
