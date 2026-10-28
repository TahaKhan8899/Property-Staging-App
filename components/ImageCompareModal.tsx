import React, { useEffect, useRef, useState } from 'react';

interface ImageCompareModalProps {
  originalUrl?: string;
  stagedUrl?: string;
  isOpen: boolean;
  onClose: () => void;
  // Version stepping (same as the card's arrows); omitted or a single version hides the controls
  versionIndex?: number;
  versionCount?: number;
  onNavigateVersion?: (direction: 'prev' | 'next') => Promise<void>;
}

const ImageCompareModal: React.FC<ImageCompareModalProps> = ({
  originalUrl,
  stagedUrl,
  isOpen,
  onClose,
  versionIndex = 0,
  versionCount = 0,
  onNavigateVersion
}) => {
  const [activeView, setActiveView] = useState<'original' | 'staged'>('original');
  const [isNavigating, setIsNavigating] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  // Ref guard so held-down arrow keys don't fire overlapping restores
  const navigatingRef = useRef(false);

  const canNavigate = !!onNavigateVersion && versionCount > 1;
  const hasPrev = canNavigate && versionIndex > 0;
  const hasNext = canNavigate && versionIndex < versionCount - 1;

  const navigateVersion = async (direction: 'prev' | 'next') => {
    if (!onNavigateVersion || navigatingRef.current) return;
    if (direction === 'prev' ? !hasPrev : !hasNext) return;
    navigatingRef.current = true;
    setIsNavigating(true);
    try {
      await onNavigateVersion(direction);
    } finally {
      navigatingRef.current = false;
      setIsNavigating(false);
    }
  };

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
        navigateVersion(event.key === 'ArrowLeft' ? 'prev' : 'next');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // No deps: rebinds each render so the handler sees the current version index
  });

  if (!isOpen || !originalUrl || !stagedUrl) return null;

  const toggleView = (view: 'original' | 'staged') => setActiveView(view);
  const imageSrc = activeView === 'original' ? originalUrl : stagedUrl;
  // Full-size renders take a moment on first view; don't leave the previous image under the new label
  const isImageLoading = loadedSrc !== imageSrc;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl h-full max-h-[90vh] rounded-2xl border border-white/10 bg-gradient-to-b from-gray-900 via-gray-900 to-black shadow-2xl overflow-hidden flex flex-col">
        <div className="p-4 flex items-center justify-between border-b border-white/10 text-white">
          <div>
            <p className="text-xs uppercase tracking-widest text-white/60 mb-1">Full Size Compare</p>
            <p className="text-base font-semibold">Toggle to inspect before / after staging</p>
          </div>
          <div className="flex items-center gap-3">
            {canNavigate && (
              <div className="flex items-center gap-1 bg-white/10 rounded-full p-1 text-xs font-semibold">
                <button
                  onClick={() => navigateVersion('prev')}
                  disabled={!hasPrev || isNavigating}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Previous version"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="px-1 tabular-nums">Version {versionIndex + 1} of {versionCount}</span>
                <button
                  onClick={() => navigateVersion('next')}
                  disabled={!hasNext || isNavigating}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Next version"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
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
            key={imageSrc}
            src={imageSrc}
            alt={activeView === 'original' ? 'Original Room' : 'Staged Room'}
            onLoad={() => setLoadedSrc(imageSrc)}
            className="w-full h-full object-contain"
          />
          {isImageLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">Loading…</div>
          )}
          <div className="absolute top-4 left-4 bg-white/90 text-gray-900 text-xs font-semibold rounded-full px-3 py-1 shadow-lg">
            {activeView === 'original' ? 'Original Photo' : `Staged Render${canNavigate ? ` · v${versionIndex + 1}` : ''}`}
          </div>
          <div className="absolute bottom-4 right-4 bg-black/60 text-white text-xs px-3 py-1 rounded-full border border-white/10">
            Space to toggle{canNavigate ? ' · ← → versions' : ''} · Esc to close
          </div>
        </div>

        <div className="p-3 text-xs text-white/70 bg-white/5 border-t border-white/10 flex items-center justify-between">
          <span>Use Original/Staged toggles or Spacebar for quick A/B testing{canNavigate ? ', arrow keys to step through versions' : ''}.</span>
          <span className="font-medium text-white">Currently Viewing: {activeView === 'original' ? 'Original' : 'Staged'}</span>
        </div>
      </div>
    </div>
  );
};

export default ImageCompareModal;
