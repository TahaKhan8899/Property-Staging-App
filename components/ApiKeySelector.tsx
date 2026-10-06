import React, { useEffect, useState } from 'react';

interface ApiKeySelectorProps {
  onKeySelected: () => void;
}

// Gemini runs on the server now, so the only check is whether the server has GEMINI_API_KEY.
const ApiKeySelector: React.FC<ApiKeySelectorProps> = ({ onKeySelected }) => {
  const [status, setStatus] = useState<'checking' | 'missing' | 'unreachable'>('checking');

  const checkKey = async () => {
    setStatus('checking');
    try {
      const res = await fetch('http://localhost:3001/api/health');
      const health = await res.json();
      if (health.geminiKeyConfigured) {
        onKeySelected();
        return;
      }
      setStatus('missing');
    } catch (e) {
      console.error('Error checking server API key status', e);
      setStatus('unreachable');
    }
  };

  useEffect(() => {
    checkKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'checking') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900 bg-opacity-90 backdrop-blur-sm">
      <div className="bg-white p-8 rounded-xl shadow-2xl max-w-md w-full text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {status === 'missing' ? 'Gemini API Key Missing' : 'Server Not Reachable'}
        </h2>
        <p className="text-gray-600 mb-6">
          {status === 'missing'
            ? <>Add <code className="font-mono text-sm">GEMINI_API_KEY=...</code> to <code className="font-mono text-sm">.env.local</code> in the project folder, then restart the server.</>
            : <>The API server on port 3001 did not respond. Start it with <code className="font-mono text-sm">npm run dev</code>.</>}
        </p>
        <button
          onClick={checkKey}
          className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow transition-colors"
        >
          Check Again
        </button>
      </div>
    </div>
  );
};

export default ApiKeySelector;
