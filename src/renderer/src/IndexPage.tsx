import React, { useEffect } from 'react';
import AuthPage from './screens/auth/authPage';
import { useNavigate } from 'react-router-dom';

export function IndexPage() {
  const navigate = useNavigate();
  const checkAuth = async () => {
    const authToken = await window.authApi.getAuthToken();
    if (authToken) {
      navigate('/home/', { replace: true });
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  return (
    <div>
      <AuthPage />
    </div>
  );
}
