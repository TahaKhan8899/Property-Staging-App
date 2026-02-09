import React, { useMemo, useState } from 'react';
import { PromptSnapshot } from '../types';

interface PromptViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  snapshot?: PromptSnapshot | string | null;
  fallbackPrompt?: string | null;
  versionLabel?: string;
  description?: string;
}

const normalizeSnapshot = (
  snapshot?: PromptViewerModalProps['snapshot'],
  fallbackPrompt?: string | null
): PromptSnapshot | null => {
  if (!snapshot) {
    return fallbackPrompt
      ? { basePrompt: fallbackPrompt, source: 'fallback', capturedAt: Date.now() }
      : null;
  }

  if (typeof snapshot === 'string') {
    try {
      const parsed = JSON.parse(snapshot);
      if (parsed && typeof parsed === 'object') {
        return parsed as PromptSnapshot;
      }
      return { basePrompt: snapshot, source: 'raw' };
    } catch {
      return { basePrompt: snapshot, source: 'raw' };
    }
  }

  return snapshot;
};

const formatDate = (timestamp?: number) => {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
};

const PromptViewerModal: React.FC<PromptViewerModalProps> = ({
  isOpen,
  onClose,
  snapshot,
  fallbackPrompt,
  versionLabel,
  description
}) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const normalizedSnapshot = useMemo(
    () => normalizeSnapshot(snapshot, fallbackPrompt),
    [snapshot, fallbackPrompt]
  );

  const basePromptText =
    normalizedSnapshot?.basePrompt ??
    fallbackPrompt ??
    normalizedSnapshot?.rawPrompt ??
    '';

  const editInstruction = normalizedSnapshot?.editInstruction;
  const source = normalizedSnapshot?.source;
  const capturedAt = normalizedSnapshot?.capturedAt;

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (!basePromptText) return;
    try {
      await navigator.clipboard?.writeText(basePromptText);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (err) {
      console.error('Failed to copy prompt', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase text-gray-500 tracking-wider">Prompt Details</p>
            <p className="text-lg font-semibold text-gray-900">
              {versionLabel || 'Current Version'}
            </p>
            {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 rounded-full p-2 transition-colors"
            aria-label="Close prompt viewer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Base Prompt
              </span>
              <button
                onClick={handleCopy}
                disabled={!basePromptText}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-full border border-gray-200 text-gray-600 hover:text-gray-900 hover:border-gray-300 disabled:opacity-40"
              >
                {copyState === 'copied' ? (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-7.778 7.778a1 1 0 01-1.414 0L3.293 9.964a1 1 0 011.414-1.414l3.101 3.101 7.071-7.071a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                    Copy Prompt
                  </>
                )}
              </button>
            </div>
            {basePromptText ? (
              <pre className="mt-3 whitespace-pre-wrap text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-xl p-4 font-mono">
                {basePromptText}
              </pre>
            ) : (
              <div className="mt-3 text-sm text-gray-500 bg-gray-50 border border-dashed border-gray-200 rounded-xl p-4">
                Prompt text was not captured for this version.
              </div>
            )}
          </div>

          {editInstruction && (
            <div>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Edit Instruction
              </span>
              <p className="mt-2 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl p-4">
                {editInstruction}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-gray-600">
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <p className="text-xs uppercase font-semibold text-gray-500 tracking-wider mb-1">
                Source
              </p>
              <p className="font-medium text-gray-900">{source || 'Unknown'}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <p className="text-xs uppercase font-semibold text-gray-500 tracking-wider mb-1">
                Captured
              </p>
              <p className="font-medium text-gray-900">
                {formatDate(capturedAt) || 'Not recorded'}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          Prompts are snapshotted for every render so you can trace how each version was produced.
        </div>
      </div>
    </div>
  );
};

export default PromptViewerModal;
