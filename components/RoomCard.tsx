import React, { useState, useRef, useEffect } from 'react';
import { RoomData, RoomType, ImageVersion, PromptSnapshot, RoomStatus } from '../types';
import { generateRoomPrompt, refineRoomPrompt, renderRoom, editRoom } from '../services/stagingApi';
import type { SavedVersion } from '../services/stagingApi';
import { getImageVersions, restoreImageVersion, uploadStagedImage, addRoomToOutput, removeRoomFromOutput } from '../services/db';
import ImageCompareModal from './ImageCompareModal';
import { isCurrentVersionInOutput, hasStaleOutput as isOutputStale } from '../services/outputState';
import PromptViewerModal from './PromptViewerModal';

const EDIT_REF_UPLOAD = '__upload__';

export interface ReferenceOption {
  id: string;
  label: string;
  url: string; // staged render of the sibling room
  currentVersionId?: string; // which version of that room is currently displayed (= what gets sent)
}

interface RoomCardProps {
  room: RoomData;
  referenceOptions?: ReferenceOption[]; // staged sibling rooms that can serve as Image 1
  apiUsage?: { calls: number; costUsd: number }; // logged Gemini spend for this room
  onUpdate: (id: string, updates: Partial<RoomData>) => void | Promise<void>;
  onRemove: (id: string) => void;
}

const ROOM_STATUS_ORDER: RoomStatus[] = ['in_progress', 'done'];
const ROOM_STATUS_META: Record<RoomStatus, { label: string; dotClass: string; activeClasses: string }> = {
  in_progress: {
    label: 'In Progress',
    dotClass: 'bg-amber-500',
    activeClasses: 'border-amber-200 bg-amber-50 text-amber-700'
  },
  done: {
    label: 'Done',
    dotClass: 'bg-emerald-500',
    activeClasses: 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }
};

// Gemini errors arrive as JSON nested inside strings; unwrap down to the innermost "message"
const toReadableError = (raw: string) => {
  let msg = raw;
  for (let i = 0; i < 3; i++) {
    const start = msg.indexOf('{');
    if (start === -1) break;
    try {
      const parsed = JSON.parse(msg.slice(start));
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner !== 'string') break;
      msg = msg.slice(0, start) + inner.trim();
    } catch {
      break;
    }
  }
  return msg;
};

// Exactly one footer phase per card. An existing render always wins over stale prompt flags,
// e.g. a staged image uploaded before the prompt was approved.
type FooterPhase = 'editingImage' | 'generatingImage' | 'imageDone' | 'generatingPrompt' | 'noPrompt' | 'promptReady' | 'promptApproved';
const getFooterPhase = (room: RoomData): FooterPhase => {
  if (room.isEditingImage) return 'editingImage';
  if (room.isGeneratingImage) return 'generatingImage';
  if (room.generatedImageUrl) return 'imageDone';
  if (room.isGeneratingPrompt) return 'generatingPrompt';
  if (!room.generatedPrompt) return 'noPrompt';
  return room.isPromptApproved ? 'promptApproved' : 'promptReady';
};

const RoomCard: React.FC<RoomCardProps> = ({ room, referenceOptions = [], apiUsage, onUpdate, onRemove }) => {
  const roomStatus = (room.roomStatus || 'in_progress') as RoomStatus;
  const [promptText, setPromptText] = useState(room.generatedPrompt);
  const [progressThought, setProgressThought] = useState<string>('');
  const [interimImageUrl, setInterimImageUrl] = useState<string | undefined>(undefined);
  const [isRefining, setIsRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [versions, setVersions] = useState<ImageVersion[]>(room.imageVersions || []);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(0);
  const [isUploadingStaged, setIsUploadingStaged] = useState(false);
  const [isDownloadingCompressed, setIsDownloadingCompressed] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [isPromptViewerOpen, setIsPromptViewerOpen] = useState(false);
  const [isSavingOutput, setIsSavingOutput] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentVersion = versions[currentVersionIndex];
  // Ignore stale ids (reference room deleted or its render discarded) -> falls back to single-image flow
  const referenceOption = referenceOptions.find(o => o.id === room.referenceRoomId);
  // Versions of the reference room, and which one to send as Image 1 ('' = whatever it currently shows)
  const [referenceVersions, setReferenceVersions] = useState<ImageVersion[]>([]);
  const [referenceVersionId, setReferenceVersionId] = useState('');

  useEffect(() => {
    if (!referenceOption) {
      setReferenceVersions([]);
      return;
    }
    let cancelled = false;
    getImageVersions(referenceOption.id)
      .then((list: ImageVersion[]) => { if (!cancelled) setReferenceVersions(list); })
      .catch(() => { if (!cancelled) setReferenceVersions([]); });
    return () => { cancelled = true; };
  }, [referenceOption?.id, referenceOption?.currentVersionId, referenceOption?.url]);

  // A pinned version that no longer belongs to the reference room falls back to "current"
  useEffect(() => {
    if (referenceVersionId && !referenceVersions.some(v => v.id === referenceVersionId)) setReferenceVersionId('');
  }, [referenceVersions, referenceVersionId]);

  const referenceCurrentVersion = referenceVersions.find(v => v.id === referenceOption?.currentVersionId)
    ?? referenceVersions[referenceVersions.length - 1];
  const pinnedReferenceVersion = referenceVersions.find(v => v.id === referenceVersionId);
  const referenceImageVersion = pinnedReferenceVersion ?? referenceCurrentVersion;
  const referenceImageUrl = referenceImageVersion?.url || referenceOption?.url;
  // Sent only when pinned, so the default request is unchanged
  const referenceRequest = referenceOption && pinnedReferenceVersion ? { referenceVersionId: pinnedReferenceVersion.id } : {};

  // Optional reference for an edit (Image 1): '' = none, a sibling room id, or EDIT_REF_UPLOAD
  const [editRef, setEditRef] = useState('');
  const [editRefVersions, setEditRefVersions] = useState<ImageVersion[]>([]);
  const [editRefVersionId, setEditRefVersionId] = useState('');
  const [editRefFile, setEditRefFile] = useState<File | null>(null);
  const [editRefFileUrl, setEditRefFileUrl] = useState<string | undefined>(undefined);
  const editRefInputRef = useRef<HTMLInputElement>(null);

  // Opening the edit panel pre-selects this room's reference angle, if it has one; closing it clears the reference
  useEffect(() => {
    if (isEditingMode) setEditRef(referenceOption?.id || '');
    else clearEditReference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditingMode]);

  useEffect(() => {
    setEditRefVersionId('');
    if (!editRef || editRef === EDIT_REF_UPLOAD) {
      setEditRefVersions([]);
      return;
    }
    let cancelled = false;
    getImageVersions(editRef)
      .then((list: ImageVersion[]) => { if (!cancelled) setEditRefVersions(list); })
      .catch(() => { if (!cancelled) setEditRefVersions([]); });
    return () => { cancelled = true; };
  }, [editRef]);

  useEffect(() => () => { if (editRefFileUrl) URL.revokeObjectURL(editRefFileUrl); }, [editRefFileUrl]);

  const clearEditReference = () => {
    setEditRef('');
    setEditRefVersionId('');
    setEditRefFile(null);
    setEditRefFileUrl(undefined);
    if (editRefInputRef.current) editRefInputRef.current.value = '';
  };

  const editRefOption = referenceOptions.find(o => o.id === editRef);
  const editRefVersion = editRefVersions.find(v => v.id === editRefVersionId);
  const editRefPreviewUrl = editRef === EDIT_REF_UPLOAD ? editRefFileUrl : (editRefVersion?.url || editRefOption?.url);

  const buildEditReferenceRequest = async () => {
    if (editRef === EDIT_REF_UPLOAD && editRefFile) {
      const referenceImage = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read the reference photo'));
        reader.readAsDataURL(editRefFile);
      });
      return { referenceImage, referenceLabel: editRefFile.name };
    }
    if (editRefOption) {
      return { referenceRoomId: editRefOption.id, ...(editRefVersion ? { referenceVersionId: editRefVersion.id } : {}) };
    }
    return {};
  };

  // Parallel candidates per render (plan 1.4). null = auto: 3 for a reference-angle room, else 1.
  const [candidateChoice, setCandidateChoice] = useState<number | null>(null);
  const candidateCount = candidateChoice ?? (referenceOption ? 3 : 1);
  // Versions produced by the last multi-candidate render, shown as a pick strip until the user moves on
  const [candidateStrip, setCandidateStrip] = useState<{ versions: SavedVersion[]; requested: number } | null>(null);

  const handlePickCandidate = async (version: SavedVersion) => {
    try {
      const { url } = await restoreImageVersion(room.id, version.id);
      onUpdate(room.id, { generatedImageUrl: url, currentVersionId: version.id, error: undefined });
      const idx = versions.findIndex(v => v.id === version.id);
      if (idx >= 0) setCurrentVersionIndex(idx);
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    }
  };

  const resolveBasePrompt = () => (room.generatedPrompt || promptText || '').trim();
  const buildPromptSnapshot = (source: string, extra: Partial<PromptSnapshot> = {}): PromptSnapshot => {
    const basePrompt = resolveBasePrompt();
    return {
      basePrompt: basePrompt || undefined,
      capturedAt: Date.now(),
      source,
      ...extra
    };
  };
  const canViewPrompt = Boolean(currentVersion?.promptSnapshot || resolveBasePrompt());
  const footerPhase = getFooterPhase(room);
  const promptVersionLabel = currentVersion
    ? `Version ${currentVersionIndex + 1} of ${versions.length || 1}`
    : 'Current Version';

  // Sync local state if parent updates
  useEffect(() => {
    setPromptText(room.generatedPrompt);
  }, [room.generatedPrompt]);

  // Load versions when image is generated, and after a discard so "Back to Render" can find them
  useEffect(() => {
    if (room.id) {
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

  useEffect(() => {
    if (!room.generatedImageUrl && isCompareOpen) {
      setIsCompareOpen(false);
    }
    if (!room.generatedImageUrl && isPromptViewerOpen) {
      setIsPromptViewerOpen(false);
    }
  }, [room.generatedImageUrl, isCompareOpen, isPromptViewerOpen]);

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
      // Server picks the reference-angle flow when the room has a staged reference room
      const { generatedPrompt: prompt } = await generateRoomPrompt(room.id, { userComments: room.initialThoughts, ...referenceRequest });
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
      const { generatedPrompt: newPrompt } = await refineRoomPrompt(room.id, promptText, refineText);
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

    const n = candidateCount;
    let finished = 0;
    const candidateStatus = () => `Generating ${n} candidates, ${finished} finished`;
    setProgressThought(n > 1 ? candidateStatus() : 'Initializing...');
    setInterimImageUrl(undefined);
    setCandidateStrip(null);

    try {
      // The server renders from the prompt stored in the DB, so make sure our pending writes have landed
      await onUpdate(room.id, { isGeneratingImage: true, error: undefined });
      const { url, currentVersionId, versions: newVersions, requested } = await renderRoom(room.id, {
        ...referenceRequest,
        candidates: n,
        onProgress: (status, img) => {
          // With several streams interleaving, show the candidate count instead of mixed thoughts
          if (n > 1) setProgressThought(candidateStatus());
          else if (status) setProgressThought(status);
          if (img) setInterimImageUrl(img);
        },
        onCandidate: () => {
          finished += 1;
          setProgressThought(candidateStatus());
        }
      });
      onUpdate(room.id, {
        generatedImageUrl: url,
        isGeneratingImage: false,
        currentVersionId
      });
      await loadVersions();
      if (requested > 1) {
        setCandidateStrip({ versions: [...newVersions].sort((a, b) => a.versionNumber - b.versionNumber), requested });
      }
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

    setCandidateStrip(null);
    onUpdate(room.id, { isEditingImage: true, error: undefined });
    setProgressThought('Initializing edit...');
    setInterimImageUrl(undefined);

    try {
      // Edits the room's current version on the server; the snapshot is recorded there
      const { url, currentVersionId } = await editRoom(room.id, {
        instructions: editText,
        ...(await buildEditReferenceRequest()),
        onProgress: (status, img) => {
          if (status) setProgressThought(status);
          if (img) setInterimImageUrl(img);
        }
      });
      onUpdate(room.id, {
        generatedImageUrl: url,
        isEditingImage: false,
        currentVersionId
      });
      setEditText('');
      setIsEditingMode(false);
      clearEditReference();
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
    setCandidateStrip(null);
    const newIndex = direction === 'prev' ? currentVersionIndex - 1 : currentVersionIndex + 1;
    if (newIndex < 0 || newIndex >= versions.length) return;

    const version = versions[newIndex];
    try {
      const { url } = await restoreImageVersion(room.id, version.id);
      onUpdate(room.id, {
        generatedImageUrl: url,
        currentVersionId: version.id,
        error: undefined
      });
      setCurrentVersionIndex(newIndex);
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    }
  };

  // Undo a Discard & Retry: re-show the version that was displayed before (or the latest)
  const handleBackToRender = async () => {
    const version = versions.find(v => v.id === room.currentVersionId) || versions[versions.length - 1];
    if (!version) return;
    try {
      const { url } = await restoreImageVersion(room.id, version.id);
      onUpdate(room.id, {
        generatedImageUrl: url,
        currentVersionId: version.id,
        error: undefined
      });
      setCurrentVersionIndex(versions.indexOf(version));
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    }
  };

  const handleUploadStaged = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploadingStaged(true);
    onUpdate(room.id, { error: undefined });

    try {
      const snapshot = buildPromptSnapshot('upload-staged');
      const { url, version } = await uploadStagedImage(room.id, file, snapshot);
      onUpdate(room.id, {
        generatedImageUrl: url,
        currentVersionId: version.id
      });
      await loadVersions();
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    } finally {
      setIsUploadingStaged(false);
    }
  };

  const handleDownload = () => {
    if (!room.generatedImageUrl) return;
    // Open image in new tab instead of downloading
    window.open(room.generatedImageUrl, '_blank');
  };

  const handleDownloadCompressed = async () => {
    if (!room.generatedImageUrl) return;

    setIsDownloadingCompressed(true);
    try {
      const url = `http://localhost:3001/api/rooms/${room.id}/download-compressed`;
      window.open(url, '_blank');
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    } finally {
      setIsDownloadingCompressed(false);
    }
  };

  const handleDeleteClick = () => {
    if (showDeleteConfirm) {
      onRemove(room.id);
    } else {
      setShowDeleteConfirm(true);
      // Auto-reset after 3 seconds
      setTimeout(() => setShowDeleteConfirm(false), 3000);
    }
  };

  const handleUploadTrigger = () => {
    if (isUploadingStaged) return;
    fileInputRef.current?.click();
  };

  // "staged/Living Room 1_v2.jpg" from ".../uploads/<Session>/staged/Living%20Room%201_v2.jpg"
  const isCurrentInOutput = isCurrentVersionInOutput(room);
  const hasStaleOutput = isOutputStale(room);

  const handleAddToOutput = async () => {
    if (!room.generatedImageUrl || isSavingOutput) return;
    setIsSavingOutput(true);
    try {
      const { outputSourcePath } = await addRoomToOutput(room.id);
      onUpdate(room.id, { outputSourcePath, error: undefined });
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    } finally {
      setIsSavingOutput(false);
    }
  };

  const handleRemoveFromOutput = async () => {
    if (isSavingOutput) return;
    setIsSavingOutput(true);
    try {
      await removeRoomFromOutput(room.id);
      onUpdate(room.id, { outputSourcePath: null });
    } catch (err) {
      onUpdate(room.id, { error: (err as Error).message });
    } finally {
      setIsSavingOutput(false);
    }
  };

  const handleRoomStatusChange = (nextStatus: RoomStatus) => {
    if (nextStatus === roomStatus) return;
    onUpdate(room.id, { roomStatus: nextStatus });
  };

  const renderReferencePicker = () => {
    if (referenceOptions.length === 0) return null;
    return (
      <div className="flex items-center justify-end gap-3 w-full">
        {referenceOption && referenceImageUrl && (
          <a
            href={referenceImageUrl}
            target="_blank"
            rel="noreferrer"
            title="Image 1 sent to Gemini (click to open full size)"
            className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700"
          >
            <img
              src={referenceImageUrl}
              alt={`Reference: ${referenceOption.label}`}
              className="h-12 aspect-video object-cover rounded border border-gray-200"
            />
          </a>
        )}
        {referenceOption && referenceVersions.length > 0 && (
          <select
            value={referenceVersionId}
            onChange={(e) => setReferenceVersionId(e.target.value)}
            title="Which render of the reference room to send as Image 1"
            className="rounded-md border-gray-300 bg-white text-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-1 px-2 border"
          >
            <option value="">Current{referenceCurrentVersion ? ` (v${referenceCurrentVersion.versionNumber})` : ''}</option>
            {referenceVersions.map(v => <option key={v.id} value={v.id}>v{v.versionNumber}</option>)}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span className="whitespace-nowrap">Reference (same room, other angle)</span>
          <select
            value={referenceOption?.id || ''}
            onChange={(e) => onUpdate(room.id, { referenceRoomId: e.target.value || null })}
            className="rounded-md border-gray-300 bg-white text-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-1 px-2 border"
          >
            <option value="">None (single image)</option>
            {referenceOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      </div>
    );
  };

  const renderBackToRenderButton = () => versions.length > 0 && (
    <button
      onClick={handleBackToRender}
      className="px-3 py-2 text-sm font-medium rounded-md transition-colors text-gray-700 hover:bg-gray-100 flex items-center gap-2"
      title="Return to the staged render shown before Discard & Retry"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
      Back to Render
    </button>
  );

  const renderUploadButton = (label: string, extraClasses = '') => (
    <button
      onClick={handleUploadTrigger}
      disabled={isUploadingStaged}
      className={`px-3 py-2 text-sm font-medium rounded-md transition-colors text-gray-700 hover:bg-gray-100 disabled:opacity-50 flex items-center gap-2 ${extraClasses}`}
    >
      {isUploadingStaged ? (
        <>
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Uploading...
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
          {label}
        </>
      )}
    </button>
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleUploadStaged}
        className="hidden"
      />
      {/* Header / Toolbar */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {apiUsage && (
            <span className="text-xs text-gray-500 whitespace-nowrap" title="Logged Gemini API spend for this room">
              ${apiUsage.costUsd.toFixed(2)} · {apiUsage.calls} calls
            </span>
          )}
          <div className="flex flex-wrap gap-2 justify-end">
            {ROOM_STATUS_ORDER.map(statusOption => {
              const meta = ROOM_STATUS_META[statusOption];
              const isActive = roomStatus === statusOption;
              return (
                <button
                  type="button"
                  key={statusOption}
                  onClick={() => handleRoomStatusChange(statusOption)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full border transition ${isActive
                    ? meta.activeClasses
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}
                >
                  <span className={`w-2 h-2 rounded-full ${meta.dotClass}`} />
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={handleDeleteClick}
            className={`text-sm font-medium transition-colors px-3 py-1 rounded ${showDeleteConfirm
              ? 'bg-red-500 text-white hover:bg-red-600'
              : 'text-gray-400 hover:text-red-500'
              }`}
            title={showDeleteConfirm ? 'Click again to confirm deletion' : 'Remove Room'}
          >
            {showDeleteConfirm ? 'Confirm Delete?' : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
            )}
          </button>
        </div>
      </div>

      {/* Content Area */}
      {/* lg+: columns share their header row (subgrid), so a wrapped staged-render toolbar
          can't push the staged image below the original */}
      <div className="p-4 flex flex-col gap-6 h-full lg:grid lg:grid-cols-2 lg:grid-rows-[auto_1fr] lg:gap-y-2">

        {/* Left: Original Image */}
        <div className="flex-1 flex flex-col gap-2 min-w-[300px] lg:grid lg:row-span-2 lg:[grid-template-rows:subgrid]">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Original</span>
          <div className="relative aspect-video bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
            <img src={room.previewUrl} alt="Original" className="w-full h-full object-cover" />
          </div>
        </div>

        {/* Right: Prompt or Result */}
        <div className="flex-1 flex flex-col gap-2 min-w-[300px] lg:grid lg:row-span-2 lg:[grid-template-rows:subgrid]">
          {/* Staged Image View if generated */}
          {room.generatedImageUrl && !room.isEditingImage ? (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-xs font-semibold text-green-600 uppercase tracking-wider flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                  Staged Render
                </span>
                <div className="flex items-center gap-2">
                  {canViewPrompt && (
                    <button
                      onClick={() => setIsPromptViewerOpen(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 text-gray-600 bg-white hover:text-gray-900 hover:border-gray-300 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 4h13M8 9h13M8 14h13M3 4h.01M3 9h.01M3 14h.01" />
                      </svg>
                      View Prompt
                    </button>
                  )}
                  <button
                    onClick={() => setIsCompareOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 text-gray-600 bg-white hover:text-gray-900 hover:border-gray-300 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H5v4M15 19h4v-4M5 19l4-4m6-6 4-4" />
                    </svg>
                    Compare
                  </button>
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
              </div>
              {candidateStrip && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2">
                  <div className="flex items-center justify-between text-xs text-indigo-800">
                    <span className="font-medium">
                      {candidateStrip.versions.length < candidateStrip.requested
                        ? `${candidateStrip.versions.length} of ${candidateStrip.requested} candidates succeeded. Pick one:`
                        : `Pick a candidate (${candidateStrip.requested}):`}
                    </span>
                    <button onClick={() => setCandidateStrip(null)} className="text-indigo-500 hover:text-indigo-700">Done</button>
                  </div>
                  <div className="flex gap-2 overflow-x-auto">
                    {candidateStrip.versions.map(v => {
                      const isCurrent = v.id === room.currentVersionId;
                      return (
                        <button
                          key={v.id}
                          onClick={() => handlePickCandidate(v)}
                          title={`Version ${v.versionNumber}: ${v.description}`}
                          className={`relative shrink-0 w-32 aspect-video rounded overflow-hidden border-2 transition ${isCurrent ? 'border-indigo-600' : 'border-transparent hover:border-indigo-300'}`}
                        >
                          <img src={v.url} alt={`Candidate v${v.versionNumber}`} className="w-full h-full object-cover" />
                          <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] text-center">v{v.versionNumber}{isCurrent ? ' (shown)' : ''}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <div className="relative aspect-video bg-gray-900 rounded-lg overflow-hidden border border-gray-200 group">
                  <img src={room.generatedImageUrl} alt="Staged" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <div className="flex gap-3">
                      <button
                        onClick={handleDownload}
                        className="bg-white text-gray-900 px-4 py-2 rounded-full font-medium shadow-lg hover:scale-105 transition-transform"
                      >
                        Download 2K
                      </button>
                      <button
                        onClick={handleDownloadCompressed}
                        disabled={isDownloadingCompressed}
                        className="bg-indigo-600 text-white px-4 py-2 rounded-full font-medium shadow-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-wait flex items-center gap-2"
                      >
                        {isDownloadingCompressed ? (
                          <>
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Compressing...
                          </>
                        ) : (
                          'Download Compressed'
                        )}
                      </button>
                    </div>
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
                    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                      <span className="whitespace-nowrap">Reference for this edit</span>
                      <select
                        value={editRef}
                        onChange={(e) => {
                          const value = e.target.value;
                          setEditRef(value);
                          if (value === EDIT_REF_UPLOAD) editRefInputRef.current?.click();
                        }}
                        className="rounded-md border-gray-300 bg-white text-gray-900 shadow-sm sm:text-sm py-1 px-2 border"
                      >
                        <option value="">None</option>
                        {referenceOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        <option value={EDIT_REF_UPLOAD}>{editRefFile ? `Photo: ${editRefFile.name}` : 'Upload photo...'}</option>
                      </select>
                      {editRefOption && editRefVersions.length > 0 && (
                        <select
                          value={editRefVersionId}
                          onChange={(e) => setEditRefVersionId(e.target.value)}
                          className="rounded-md border-gray-300 bg-white text-gray-900 shadow-sm sm:text-sm py-1 px-2 border"
                        >
                          <option value="">Current</option>
                          {editRefVersions.map(v => <option key={v.id} value={v.id}>v{v.versionNumber}</option>)}
                        </select>
                      )}
                      <input
                        ref={editRefInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setEditRefFile(file);
                          setEditRefFileUrl(URL.createObjectURL(file));
                          setEditRef(EDIT_REF_UPLOAD);
                        }}
                      />
                      {editRefPreviewUrl && (
                        <img
                          src={editRefPreviewUrl}
                          alt="Edit reference"
                          title="Sent as Image 1. Mention it in your edit, e.g. 'match the sofa in the reference image'."
                          className="h-12 aspect-video object-cover rounded border border-gray-200"
                        />
                      )}
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => {
                          setIsEditingMode(false);
                          setEditText('');
                          clearEditReference();
                        }}
                        className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleEditImage}
                        disabled={!editText.trim() || (editRef === EDIT_REF_UPLOAD && !editRefFile)}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        Apply Edits
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
              <div className="flex flex-col gap-2 h-full">
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
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer / Actions */}
      <div className="bg-gray-50 px-4 py-3 border-t border-gray-100 flex flex-wrap items-center gap-2 justify-end">
        {room.error && (
          <span className="text-red-600 text-sm mr-auto flex items-center gap-1" title={room.error}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {toReadableError(room.error)}
            <button
              onClick={() => onUpdate(room.id, { error: undefined })}
              className="ml-1 p-0.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
              title="Dismiss error"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </span>
        )}

        {/* State 0: Generating Prompt */}
        {footerPhase === 'generatingPrompt' && (
          <button disabled className="px-4 py-2 bg-indigo-50 text-indigo-700 text-sm font-medium rounded-md cursor-wait flex items-center gap-2">
            <svg className="animate-spin h-4 w-4 text-indigo-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Generating Prompt...
          </button>
        )}

        {/* State 1: No Prompt Generated Yet */}
        {footerPhase === 'noPrompt' && (
          <div className="flex flex-col gap-2 w-full sm:w-auto items-end">
            {renderReferencePicker()}
            <textarea
              placeholder="Initial thoughts (e.g. 'Use a mid-century style', 'Include a coffee maker')..."
              value={room.initialThoughts || ''}
              onChange={(e) => onUpdate(room.id, { initialThoughts: e.target.value })}
              className="w-full sm:w-80 text-sm border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 border p-2 h-20 resize-none"
            />
            <div className="flex flex-wrap gap-2 justify-end w-full sm:w-auto">
              {renderBackToRenderButton()}
              {renderUploadButton('Upload Staged Image')}
              <button
                onClick={handleGeneratePrompt}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 shadow-sm"
              >
                Generate Prompt
              </button>
            </div>
          </div>
        )}

        {/* State 2: Prompt Generated, Not Approved */}
        {footerPhase === 'promptReady' && (
          <>
            {renderReferencePicker()}
            {renderBackToRenderButton()}
            {renderUploadButton('Upload Staged Image')}
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
        {footerPhase === 'promptApproved' && (
          <>
            {renderBackToRenderButton()}
            {renderUploadButton('Upload Staged Image')}
            <button
              onClick={() => onUpdate(room.id, { isPromptApproved: false })}
              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Edit Prompt
            </button>
            <label
              className="flex items-center gap-1.5 text-sm text-gray-600"
              title="Renders run in parallel; each is saved as its own version. About $0.13 per candidate."
            >
              <select
                value={candidateCount}
                onChange={(e) => setCandidateChoice(Number(e.target.value))}
                className="rounded-md border-gray-300 bg-white text-gray-900 shadow-sm sm:text-sm py-1 px-2 border"
              >
                {[1, 2, 3].map(k => <option key={k} value={k}>{k} {k === 1 ? 'candidate' : 'candidates'}</option>)}
              </select>
              <span className="text-xs text-gray-400 whitespace-nowrap">≈ ${(0.13 * candidateCount).toFixed(2)}</span>
            </label>
            <button
              onClick={handleGenerateImage}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 shadow-sm flex items-center gap-2"
            >
              Generate Staged Image (2K)
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            </button>
          </>
        )}

        {/* State 4: Generating Image */}
        {footerPhase === 'generatingImage' && (
          <button disabled className="px-4 py-2 bg-indigo-50 text-indigo-700 text-sm font-medium rounded-md cursor-wait flex items-center gap-2">
            <svg className="animate-spin h-4 w-4 text-indigo-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {progressThought || 'Thinking & Rendering...'}
          </button>
        )}

        {/* State 5: Image Done */}
        {footerPhase === 'imageDone' && (
          <>
            {isCurrentInOutput ? (
              <button
                onClick={handleRemoveFromOutput}
                disabled={isSavingOutput}
                title="This version is in the output folder. Click to remove it."
                className="px-3 py-2 text-sm font-medium rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                In Output
              </button>
            ) : (
              <button
                onClick={handleAddToOutput}
                disabled={isSavingOutput}
                title={hasStaleOutput ? 'A different version is in the output folder. Click to replace it with this one.' : 'Copy this version to the session output folder'}
                className={`px-3 py-2 text-sm font-medium rounded-md border disabled:opacity-50 flex items-center gap-2 ${hasStaleOutput
                  ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                {isSavingOutput ? 'Saving...' : hasStaleOutput ? 'Replace Output' : 'Add to Output'}
              </button>
            )}
            {renderUploadButton('Upload Staged Image')}
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
              // Only skip straight to "Generate Staged Image" when there is a prompt to generate from
              onClick={() => onUpdate(room.id, { generatedImageUrl: undefined, isPromptApproved: Boolean(room.generatedPrompt), error: undefined })}
              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Discard & Retry
            </button>
          </>
        )}
      </div>
      {room.generatedImageUrl && (
        <ImageCompareModal
          isOpen={isCompareOpen}
          originalUrl={room.previewUrl}
          stagedUrl={room.generatedImageUrl}
          onClose={() => setIsCompareOpen(false)}
        />
      )}
      <PromptViewerModal
        isOpen={isPromptViewerOpen}
        onClose={() => setIsPromptViewerOpen(false)}
        snapshot={currentVersion?.promptSnapshot}
        fallbackPrompt={resolveBasePrompt() || null}
        versionLabel={promptVersionLabel}
        description={currentVersion?.description}
      />
    </div>
  );
};

export default RoomCard;
