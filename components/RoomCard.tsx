import React, { useState, useRef, useEffect } from 'react';
import { RoomData, RoomType, ImageVersion } from '../types';
import { generateStagingPrompt, generateStagedImage, refinePrompt, editGeneratedImage } from '../services/geminiService';
import { saveGeneratedImage, getImageVersions, restoreImageVersion } from '../services/db';

interface RoomCardProps {
  room: RoomData;
  onUpdate: (id: string, updates: Partial<RoomData>) => void;
  onRemove: (id: string) => void;
}

const RoomCard: React.FC<RoomCardProps> = ({ room, onUpdate, onRemove }) => {
  const [promptText, setPromptText] = useState(room.generatedPrompt);
  const [progressThought, setProgressThought] = useState<string>('');
  const [interimImageUrl, setInterimImageUrl] = useState<string | undefined>(undefined);
  const [isRefining, setIsRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [versions, setVersions] = useState<ImageVersion[]>(room.imageVersions || []);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync local state if parent updates
  useEffect(() => {
    setPromptText(room.generatedPrompt);
  }, [room.generatedPrompt]);

  // Load versions when image is generated
  useEffect(() => {
    if (room.generatedImageUrl && room.id) {
      loadVersions();
    }
  }, [room.generatedImageUrl, room.id]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [promptText]);

  const loadVersions = async () => {
    try {
      console.log('Loading versions for room:', room.id);
      const versionList = await getImageVersions(room.id);
      console.log('Loaded versions:', versionList);
      setVersions(versionList);
      // Find current version index
      if (room.currentVersionId) {
        const idx = versionList.findIndex(v => v.id === room.currentVersionId);
        console.log('Current version ID:', room.currentVersionId, 'Index:', idx);
        if (idx !== -1) setCurrentVersionIndex(idx);
      } else {
        setCurrentVersionIndex(versionList.length - 1);
      }
    } catch (err) {
      console.error('Failed to load versions:', err);
    }
  };

  const handleGeneratePrompt = async () => {
    onUpdate(room.id, { isGeneratingPrompt: true, error: undefined });
    try {
      let prompt = await generateStagingPrompt(
        room.file || room.previewUrl,
        room.roomType,
        room.customLabel,
        room.initialThoughts
      );
      // Strip opening and closing quotes if present
      prompt = prompt.replace(/^["']|["']$/g, '').trim();
      onUpdate(room.id, {
        generatedPrompt: prompt,
        initialPrompt: prompt, // Save original for reset
        isGeneratingPrompt: false,
        isPromptApproved: false
      });
    } catch (err) {
      onUpdate(room.id, {
        isGeneratingPrompt: false,
        error: (err as Error).message
      });
    }
  };

  const handleApprovePrompt = () => {
    onUpdate(room.id, {
      generatedPrompt: promptText, // Save manual edits
      isPromptApproved: true
    });
  };



  const handleRefinePrompt = async () => {
    if (!refineText.trim() || isRefining) return;

    setIsRefining(true);
    try {
      const newPrompt = await refinePrompt(promptText, refineText);
      setPromptText(newPrompt);
      setRefineText(''); // Clear input after success
      onUpdate(room.id, { generatedPrompt: newPrompt });
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    } finally {
      setIsRefining(false);
    }
  };

  const handleResetPrompt = () => {
    // Revert to the initial prompt if available
    const original = room.initialPrompt || room.generatedPrompt;
    setPromptText(original);
    // Also update parent state to reflect the reset immediately so "Approve" works on original
    onUpdate(room.id, { generatedPrompt: original });
  };

  const handleGenerateImage = async () => {
    if (!room.isPromptApproved) return;

    onUpdate(room.id, { isGeneratingImage: true, error: undefined });
    setProgressThought('Initializing...');
    setInterimImageUrl(undefined);

    try {
      const imageBase64 = await generateStagedImage(
        room.file || room.previewUrl,
        room.generatedPrompt,
        (status, img) => {
          if (status) setProgressThought(status);
          if (img) setInterimImageUrl(img);
        }
      );
      const { url, version } = await saveGeneratedImage(room.id, imageBase64, 'Initial generation');
      onUpdate(room.id, {
        generatedImageUrl: url,
        isGeneratingImage: false,
        currentVersionId: version.id
      });
      await loadVersions();
    } catch (err) {
      onUpdate(room.id, {
        isGeneratingImage: false,
        error: (err as Error).message
      });
    } finally {
      setProgressThought('');
      setInterimImageUrl(undefined);
    }
  };

  const handleEditImage = async () => {
    if (!editText.trim() || !room.generatedImageUrl) return;

    onUpdate(room.id, { isEditingImage: true, error: undefined });
    setProgressThought('Initializing edit...');
    setInterimImageUrl(undefined);

    try {
      const editedImageBase64 = await editGeneratedImage(
        room.generatedImageUrl,
        editText,
        (status, img) => {
          if (status) setProgressThought(status);
          if (img) setInterimImageUrl(img);
        }
      );
      const { url, version } = await saveGeneratedImage(room.id, editedImageBase64, `Edit: ${editText.substring(0, 50)}`);
      onUpdate(room.id, {
        generatedImageUrl: url,
        isEditingImage: false,
        currentVersionId: version.id
      });
      setEditText('');
      setIsEditingMode(false);
      await loadVersions();
    } catch (err) {
      onUpdate(room.id, {
        isEditingImage: false,
        error: (err as Error).message
      });
    } finally {
      setProgressThought('');
      setInterimImageUrl(undefined);
    }
  };

  const handleVersionNavigation = async (direction: 'prev' | 'next') => {
    const newIndex = direction === 'prev' ? currentVersionIndex - 1 : currentVersionIndex + 1;
    if (newIndex < 0 || newIndex >= versions.length) return;

    const version = versions[newIndex];
    try {
      const { url } = await restoreImageVersion(room.id, version.id);
      onUpdate(room.id, {
        generatedImageUrl: url,
        currentVersionId: version.id
      });
      setCurrentVersionIndex(newIndex);
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    }
  };

  const handleDownload = () => {
    if (!room.generatedImageUrl) return;
    // Open image in new tab instead of downloading
    window.open(room.generatedImageUrl, '_blank');
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
      {/* Header / Toolbar */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <select
            value={room.roomType}
            onChange={(e) => onUpdate(room.id, { roomType: e.target.value as RoomType })}
            className="block w-40 rounded-md border-gray-300 bg-white text-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-1 px-2 border"
          >
            {Object.values(RoomType).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {room.roomType === RoomType.Other && (
            <input
              type="text"
              placeholder="Custom Label"
              value={room.customLabel || ''}
              onChange={(e) => onUpdate(room.id, { customLabel: e.target.value })}
              className="block w-40 rounded-md border-gray-300 bg-white text-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-1 px-2 border"
            />
          )}
        </div>
        <button
          onClick={() => onRemove(room.id)}
          className="text-gray-400 hover:text-red-500 transition-colors"
          title="Remove Room"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Content Area */}
      <div className="p-4 flex flex-col lg:flex-row gap-6 h-full">

        {/* Left: Original Image */}
        <div className="flex-1 flex flex-col gap-2 min-w-[300px]">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Original</span>
          <div className="relative aspect-video bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
            <img src={room.previewUrl} alt="Original" className="w-full h-full object-cover" />
          </div>
        </div>

        {/* Right: Prompt or Result */}
        <div className="flex-1 flex flex-col gap-2 min-w-[300px]">
          {/* Staged Image View if generated */}
          {room.generatedImageUrl && !room.isEditingImage ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-green-600 uppercase tracking-wider flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                  Staged Render
                </span>
                {versions.length > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleVersionNavigation('prev')}
                      disabled={currentVersionIndex === 0}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Previous version"
                    >
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="text-xs font-medium text-gray-600 bg-gray-100 px-2 py-1 rounded">
                      Version {currentVersionIndex + 1} of {versions.length}
                    </span>
                    <button
                      onClick={() => handleVersionNavigation('next')}
                      disabled={currentVersionIndex === versions.length - 1}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Next version"
                    >
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
              <div className="relative aspect-video bg-gray-900 rounded-lg overflow-hidden group">
                <img src={room.generatedImageUrl} alt="Staged" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <button
                    onClick={handleDownload}
                    className="bg-white text-gray-900 px-4 py-2 rounded-full font-medium shadow-lg hover:scale-105 transition-transform"
                  >
                    Download 4K
                  </button>
                </div>
              </div>

              {/* Edit Interface - shown when in edit mode */}
              {isEditingMode && (
                <div className="mt-2 flex flex-col gap-2">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    placeholder="Enter your edits (e.g., 'Make the sofa blue', 'Add a plant on the coffee table', 'Change the rug to a lighter color')"
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border h-24 resize-none"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        setIsEditingMode(false);
                        setEditText('');
                      }}
                      className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleEditImage}
                      disabled={!editText.trim()}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      Apply Edits
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : room.isEditingImage ? (
            /* Editing View with Progress */
            <>
              <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider flex items-center gap-2 animate-pulse">
                <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Editing Image...
              </span>
              <div className="relative aspect-video bg-gray-50 rounded-lg overflow-hidden border border-gray-200 flex flex-col items-center justify-center">
                {interimImageUrl ? (
                  <>
                    <img src={interimImageUrl} alt="Interim Edit" className="w-full h-full object-cover opacity-80 blur-sm transition-all duration-500" />
                    <div className="absolute inset-x-0 bottom-0 bg-black/50 p-2 text-white text-xs text-center backdrop-blur-md">
                      {progressThought}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 p-6 text-center">
                    <div className="animate-bounce">
                      <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-500 font-medium animate-pulse">{progressThought || 'Connecting to Gemini...'}</p>
                  </div>
                )}
              </div>
            </>
          ) : room.isGeneratingImage ? (
            /* Generating View with Progress */
            <>
              <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider flex items-center gap-2 animate-pulse">
                <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Generating...
              </span>
              <div className="relative aspect-video bg-gray-50 rounded-lg overflow-hidden border border-gray-200 flex flex-col items-center justify-center">
                {interimImageUrl ? (
                  <>
                    <img src={interimImageUrl} alt="Interim Staging" className="w-full h-full object-cover opacity-80 blur-sm transition-all duration-500" />
                    <div className="absolute inset-x-0 bottom-0 bg-black/50 p-2 text-white text-xs text-center backdrop-blur-md">
                      {progressThought}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 p-6 text-center">
                    <div className="animate-bounce">
                      <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-500 font-medium animate-pulse">{progressThought || 'Connecting to Gemini...'}</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* Prompt Editing View */
            <>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex justify-between">
                <span>Staging Prompt</span>
                {room.isGeneratingPrompt && <span className="text-indigo-600 animate-pulse">Generating...</span>}
              </span>
              <div className="flex-1 relative">
                <textarea
                  ref={textareaRef}
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  disabled={room.isGeneratingPrompt || room.isGeneratingImage || room.isPromptApproved}
                  placeholder={room.isGeneratingPrompt ? "Gemini is analyzing the room..." : "No prompt generated yet. Click 'Generate Prompt' below."}
                  className={`w-full h-full min-h-[180px] p-3 text-sm rounded-lg border focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none transition-colors ${room.isPromptApproved ? 'bg-green-50 border-green-200 text-gray-700' : 'bg-white border-gray-300'
                    }`}
                />
                {room.isPromptApproved && (
                  <div className="absolute top-2 right-2 bg-green-100 text-green-800 text-xs px-2 py-1 rounded-full font-medium">
                    Approved
                  </div>
                )}
              </div>

              {/* Prompt Refinement Input (Visible when prompt exists but not generating image) */}
              {room.generatedPrompt && !room.isGeneratingImage && !room.isPromptApproved && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRefinePrompt()}
                    disabled={isRefining}
                    placeholder="Refine prompt (e.g. 'Make the sofa blue', 'Add a plant')"
                    className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
                  />
                  <button
                    onClick={handleRefinePrompt}
                    disabled={isRefining || !refineText.trim()}
                    className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                  >
                    {isRefining ? (
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer / Actions */}
      <div className="bg-gray-50 px-4 py-3 border-t border-gray-100 flex flex-wrap gap-2 justify-end">
        {room.error && (
          <span className="text-red-600 text-sm mr-auto self-center flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {room.error}
          </span>
        )}

        {/* State 1: No Prompt Generated Yet */}
        {!room.generatedPrompt && !room.isGeneratingPrompt && (
          <div className="flex flex-col gap-2 w-full sm:w-auto items-end">
            <textarea
              placeholder="Initial thoughts (e.g. 'Use a mid-century style', 'Include a coffee maker')..."
              value={room.initialThoughts || ''}
              onChange={(e) => onUpdate(room.id, { initialThoughts: e.target.value })}
              className="w-full sm:w-80 text-sm border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 border p-2 h-20 resize-none"
            />
            <button
              onClick={handleGeneratePrompt}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 shadow-sm self-end"
            >
              Generate Prompt
            </button>
          </div>
        )}

        {/* State 2: Prompt Generated, Not Approved */}
        {room.generatedPrompt && !room.isPromptApproved && !room.isGeneratingImage && (
          <>
            <button
              onClick={handleGeneratePrompt}
              className="px-3 py-2 text-gray-700 hover:bg-white hover:text-gray-900 text-sm font-medium rounded-md transition-colors border border-transparent hover:border-gray-200"
            >
              Regenerate
            </button>
            <button
              onClick={handleResetPrompt}
              className="px-3 py-2 text-gray-700 hover:bg-white text-sm font-medium rounded-md transition-colors"
              title="Reset to original AI prompt"
            >
              Reset
            </button>
            <button
              onClick={handleApprovePrompt}
              className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-black shadow-sm flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
              Approve Prompt
            </button>
          </>
        )}

        {/* State 3: Prompt Approved, Ready for Image Gen */}
        {room.isPromptApproved && !room.generatedImageUrl && !room.isGeneratingImage && (
          <>
            <button
              onClick={() => onUpdate(room.id, { isPromptApproved: false })}
              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Edit Prompt
            </button>
            <button
              onClick={handleGenerateImage}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 shadow-sm flex items-center gap-2"
            >
              Generate Staged Image (4K)
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            </button>
          </>
        )}

        {/* State 4: Generating Image */}
        {room.isGeneratingImage && (
          <button disabled className="px-4 py-2 bg-indigo-50 text-indigo-700 text-sm font-medium rounded-md cursor-wait flex items-center gap-2">
            <svg className="animate-spin h-4 w-4 text-indigo-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {/* Show Timer equivalent, but mostly status now */}
            Thinking & Rendering...
          </button>
        )}

        {/* State 5: Image Done */}
        {room.generatedImageUrl && !room.isEditingImage && (
          <>
            <button
              onClick={() => setIsEditingMode(!isEditingMode)}
              className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${isEditingMode
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-700 hover:bg-gray-100'
                }`}
            >
              {isEditingMode ? 'Cancel Edit' : 'Edit Image'}
            </button>
            <button
              onClick={() => onUpdate(room.id, { generatedImageUrl: undefined, isPromptApproved: true })}
              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Discard & Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default RoomCard;