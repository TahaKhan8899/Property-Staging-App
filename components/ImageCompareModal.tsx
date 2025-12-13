import React, { useEffect, useState } from 'react';

interface ImageCompareModalProps {
  originalUrl?: string;
  stagedUrl?: string;
  isOpen: boolean;
  onClose: () => void;
}

const ImageCompareModal: React.FC<ImageCompareModalProps> = ({
  originalUrl,
  stagedUrl,
  isOpen,
  onClose
}) => {
  const [activeView, setActiveView] = useState<'original' | 'staged'>('original');

  useEffect(() => {
    if (isOpen) {
      setActiveView('original');
      document.body.style.setProperty('overflow', 'hidden');
    }
    return () => {
      document.body.style.removeProperty('overflow');
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        setActiveView((prev) => (prev === 'original' ? 'staged' : 'original'));
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        setActiveView(event.key === 'ArrowLeft' ? 'original' : 'staged');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !originalUrl || !stagedUrl) return null;

  const toggleView = (view: 'original' | 'staged') => setActiveView(view);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl h-full max-h-[90vh] rounded-2xl border border-white/10 bg-gradient-to-b from-gray-900 via-gray-900 to-black shadow-2xl overflow-hidden flex flex-col">
        <div className="p-4 flex items-center justify-between border-b border-white/10 text-white">
          <div>
            <p className="text-xs uppercase tracking-widest text-white/60 mb-1">Full Size Compare</p>
            <p className="text-base font-semibold">Toggle to inspect before / after staging</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="bg-white/10 rounded-full p-1 flex text-xs font-semibold uppercase tracking-wide">
              <button
                onClick={() => toggleView('original')}
                className={`px-3 py-1 rounded-full transition-colors ${activeView === 'original' ? 'bg-white text-gray-900' : 'text-white/70 hover:text-white'}`}
              >
                Original
              </button>
              <button
                onClick={() => toggleView('staged')}
                className={`px-3 py-1 rounded-full transition-colors ${activeView === 'staged' ? 'bg-white text-gray-900' : 'text-white/70 hover:text-white'}`}
              >
                Staged
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
              aria-label="Close comparison"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="relative flex-1 bg-black">
          <img
            src={activeView === 'original' ? originalUrl : stagedUrl}
            alt={activeView === 'original' ? 'Original Room' : 'Staged Room'}
            className="w-full h-full object-contain"
          />
          <div className="absolute top-4 left-4 bg-white/90 text-gray-900 text-xs font-semibold rounded-full px-3 py-1 shadow-lg">
            {activeView === 'original' ? 'Original Photo' : 'Staged Render'}
          </div>
          <div className="absolute bottom-4 right-4 bg-black/60 text-white text-xs px-3 py-1 rounded-full border border-white/10">
            Press Space to toggle · Esc to close
          </div>
        </div>

        <div className="p-3 text-xs text-white/70 bg-white/5 border-t border-white/10 flex items-center justify-between">
          <span>Use Original/Staged toggles or Spacebar for quick A/B testing.</span>
          <span className="font-medium text-white">Currently Viewing: {activeView === 'original' ? 'Original' : 'Staged'}</span>
        </div>
      </div>
    </div>
  );
};

export default ImageCompareModal;
