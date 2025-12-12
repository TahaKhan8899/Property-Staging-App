import React, { useEffect, useState } from 'react';

interface ApiKeySelectorProps {
  onKeySelected: () => void;
}

const ApiKeySelector: React.FC<ApiKeySelectorProps> = ({ onKeySelected }) => {
  const [loading, setLoading] = useState(false);

  const checkKey = async () => {
    try {
      if (window.aistudio && window.aistudio.hasSelectedApiKey) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (hasKey) {
          onKeySelected();
        }
      }
    } catch (e) {
      console.error("Error checking API key status", e);
    }
  };

  useEffect(() => {
    checkKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectKey = async () => {
    setLoading(true);
    try {
      if (window.aistudio && window.aistudio.openSelectKey) {
        await window.aistudio.openSelectKey();
        // Assume success after dialog interaction per guidelines
        onKeySelected();
      } else {
        alert("AI Studio environment not detected. Please run in Google AI Studio.");
      }
    } catch (e) {
      console.error("Error selecting key", e);
      // If "Requested entity was not found" occurs, we might need to reset,
      // but guidelines say just assume success or retry.
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900 bg-opacity-90 backdrop-blur-sm">
      <div className="bg-white p-8 rounded-xl shadow-2xl max-w-md w-full text-center">
        <div className="mb-6">
          <svg className="w-16 h-16 mx-auto text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">API Key Required</h2>
        <p className="text-gray-600 mb-6">
          To use the High-Quality Image Generation (Gemini 3 Pro / Nano Banana Pro), you must select a paid API key from a Google Cloud Project.
        </p>
        
        <button
          onClick={handleSelectKey}
          disabled={loading}
          className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow transition-colors disabled:opacity-50"
        >
          {loading ? 'Connecting...' : 'Select Paid API Key'}
        </button>

        <p className="mt-4 text-xs text-gray-500">
          Learn more about billing at <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">ai.google.dev/gemini-api/docs/billing</a>
        </p>
      </div>
    </div>
  );
};

export default ApiKeySelector;