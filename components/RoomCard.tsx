import React, { useState, useRef, useEffect } from 'react';
import { RoomData, RoomType } from '../types';
import { generateStagingPrompt, generateStagedImage } from '../services/geminiService';

interface RoomCardProps {
  room: RoomData;
  onUpdate: (id: string, updates: Partial<RoomData>) => void;
  onRemove: (id: string) => void;
}

const RoomCard: React.FC<RoomCardProps> = ({ room, onUpdate, onRemove }) => {
  const [promptText, setPromptText] = useState(room.generatedPrompt);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync local state if parent updates
  useEffect(() => {
    setPromptText(room.generatedPrompt);
  }, [room.generatedPrompt]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [promptText]);

  const handleGeneratePrompt = async () => {
    onUpdate(room.id, { isGeneratingPrompt: true, error: undefined });
    try {
      const prompt = await generateStagingPrompt(room.file || room.previewUrl, room.roomType, room.customLabel);
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
    try {
      const imageUrl = await generateStagedImage(room.file || room.previewUrl, room.generatedPrompt);
      onUpdate(room.id, {
        generatedImageUrl: imageUrl,
        isGeneratingImage: false
      });
    } catch (err) {
      onUpdate(room.id, {
        isGeneratingImage: false,
        error: (err as Error).message
      });
    }
  };

  const handleDownload = () => {
    if (!room.generatedImageUrl) return;
    const link = document.createElement('a');
    link.href = room.generatedImageUrl;
    // Determine extension from data URL if possible
    let extension = 'png';
    const mimeMatch = room.generatedImageUrl.match(/^data:image\/(\w+);/);
    if (mimeMatch) {
      extension = mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1];
    }
    link.download = `staged-${room.roomType.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
          {room.generatedImageUrl ? (
            <>
              <span className="text-xs font-semibold text-green-600 uppercase tracking-wider flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                Staged Render
              </span>
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
          <button
            onClick={handleGeneratePrompt}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 shadow-sm"
          >
            Generate Prompt
          </button>
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
            Rendering 4K Image...
          </button>
        )}

        {/* State 5: Image Done */}
        {room.generatedImageUrl && (
          <button
            onClick={() => onUpdate(room.id, { generatedImageUrl: undefined, isPromptApproved: true })}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Discard & Retry
          </button>
        )}
      </div>
    </div>
  );
};

export default RoomCard;