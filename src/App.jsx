import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const DEFAULT_PIXELS_PER_SECOND = 24;
const MIN_PIXELS_PER_SECOND = 8;
const MAX_PIXELS_PER_SECOND = 72;
const MIN_CLIP_DURATION = 0.25;

const effects = [
  { id: 1, name: "Applauso", category: "Live" },
  { id: 2, name: "Boom Impact", category: "Impact" },
  { id: 3, name: "Whoosh", category: "Transition" },
  { id: 4, name: "Echo Hit", category: "FX" },
  { id: 5, name: "Riser", category: "Build Up" },
];

const clipColors = ["blue", "purple", "green", "orange", "pink"];

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";

  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);

  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatPreciseTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00.00";

  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  const cent = Math.floor((seconds % 1) * 100);

  return `${String(min).padStart(2, "0")}:${String(sec).padStart(
    2,
    "0"
  )}.${String(cent).padStart(2, "0")}`;
}

function isAudioFile(file) {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)
  );
}

function buildWaveformPeaks(audioBuffer, samples = 900, startTime = 0, duration = null) {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const safeStartTime = Math.max(0, startTime || 0);
  const safeDuration = Math.max(
    0.01,
    duration ?? audioBuffer.duration - safeStartTime
  );

  const startSample = Math.min(
    channelData.length - 1,
    Math.floor(safeStartTime * sampleRate)
  );

  const endSample = Math.min(
    channelData.length,
    startSample + Math.floor(safeDuration * sampleRate)
  );

  const totalSamples = Math.max(1, endSample - startSample);
  const blockSize = Math.max(1, Math.floor(totalSamples / samples));
  const peaks = [];

  for (let i = 0; i < samples; i++) {
    const blockStart = startSample + i * blockSize;
    const blockEnd = Math.min(endSample, blockStart + blockSize);
    let max = 0;

    for (let j = blockStart; j < blockEnd; j++) {
      const value = Math.abs(channelData[j] || 0);
      if (value > max) max = value;
    }

    peaks.push(max);
  }

  const highestPeak = Math.max(...peaks) || 1;

  return peaks.map((peak) => peak / highestPeak);
}

function normalizeRenderedBuffer(audioBuffer, targetPeak = 0.98) {
  const channels = audioBuffer.numberOfChannels;
  let maxPeak = 0;

  for (let channel = 0; channel < channels; channel++) {
    const data = audioBuffer.getChannelData(channel);

    for (let i = 0; i < data.length; i++) {
      const absoluteValue = Math.abs(data[i]);
      if (absoluteValue > maxPeak) maxPeak = absoluteValue;
    }
  }

  if (maxPeak <= targetPeak || maxPeak === 0) {
    return audioBuffer;
  }

  const multiplier = targetPeak / maxPeak;

  for (let channel = 0; channel < channels; channel++) {
    const data = audioBuffer.getChannelData(channel);

    for (let i = 0; i < data.length; i++) {
      data[i] *= multiplier;
    }
  }

  return audioBuffer;
}

function audioBufferToWavBlob(audioBuffer) {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const format = 1;
  const bitDepth = 16;
  const samplesLength = audioBuffer.length;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samplesLength * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: numberOfChannels }, (_, channel) =>
    audioBuffer.getChannelData(channel)
  );

  let offset = 44;

  for (let sample = 0; sample < samplesLength; sample++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const value = Math.max(-1, Math.min(1, channelData[channel][sample] || 0));
      const intValue = value < 0 ? value * 0x8000 : value * 0x7fff;
      view.setInt16(offset, intValue, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function makeExportFileName(extension = "wav") {
  const now = new Date();
  const stamp = now
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");

  return `show-audio-studio-${stamp}.${extension}`;
}

function floatTo16BitPcm(float32Array) {
  const output = new Int16Array(float32Array.length);

  for (let i = 0; i < float32Array.length; i++) {
    const value = Math.max(-1, Math.min(1, float32Array[i] || 0));
    output[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }

  return output;
}

async function audioBufferToMp3Blob(audioBuffer, kbps = 192) {
  const lameModule = await import("@breezystack/lamejs");
  const lame = lameModule.default || lameModule;
  const Mp3Encoder = lame.Mp3Encoder || lameModule.Mp3Encoder;

  if (!Mp3Encoder) {
    throw new Error("Encoder MP3 non disponibile. Verifica di aver installato @breezystack/lamejs.");
  }

  const numberOfChannels = Math.min(2, Math.max(1, audioBuffer.numberOfChannels));
  const sampleRate = audioBuffer.sampleRate;
  const encoder = new Mp3Encoder(numberOfChannels, sampleRate, kbps);
  const sampleBlockSize = 1152;
  const mp3Chunks = [];

  const left = floatTo16BitPcm(audioBuffer.getChannelData(0));
  const right =
    numberOfChannels > 1
      ? floatTo16BitPcm(audioBuffer.getChannelData(1))
      : null;

  for (let i = 0; i < left.length; i += sampleBlockSize) {
    const leftChunk = left.subarray(i, i + sampleBlockSize);
    let mp3Buffer;

    if (numberOfChannels > 1 && right) {
      const rightChunk = right.subarray(i, i + sampleBlockSize);
      mp3Buffer = encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      mp3Buffer = encoder.encodeBuffer(leftChunk);
    }

    if (mp3Buffer.length > 0) {
      mp3Chunks.push(mp3Buffer);
    }
  }

  const finalBuffer = encoder.flush();

  if (finalBuffer.length > 0) {
    mp3Chunks.push(finalBuffer);
  }

  return new Blob(mp3Chunks, { type: "audio/mpeg" });
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

async function saveBlobToDevice(blob, fileName, mimeType, extension) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: `${extension.toUpperCase()} audio`,
            accept: {
              [mimeType]: [`.${extension}`],
            },
          },
        ],
      });

      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "picker";
    } catch (error) {
      if (error?.name === "AbortError") {
        return "cancelled";
      }

      console.warn("Salvataggio diretto non riuscito, uso fallback:", error);
    }
  }

  const file = new File([blob], fileName, { type: mimeType });

  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({
        title: fileName,
        files: [file],
      });

      return "share";
    } catch (error) {
      if (error?.name === "AbortError") {
        return "cancelled";
      }

      console.warn("Condivisione file non riuscita, uso download:", error);
    }
  }

  downloadBlob(blob, fileName);
  return "download";
}

const PROJECT_DB_NAME = "show-audio-studio-projects";
const PROJECT_STORE_NAME = "projects";
const DEFAULT_PROJECT_ID = "autosave";

function openProjectDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        db.createObjectStore(PROJECT_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveProjectRecord(project) {
  const db = await openProjectDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE_NAME, "readwrite");
    tx.objectStore(PROJECT_STORE_NAME).put(project);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadProjectRecord(projectId = DEFAULT_PROJECT_ID) {
  const db = await openProjectDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE_NAME, "readonly");
    const request = tx.objectStore(PROJECT_STORE_NAME).get(projectId);

    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

function App() {
  const [tracks, setTracks] = useState([]);
  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isDraggingClip, setIsDraggingClip] = useState(false);
  const [isTrimmingClip, setIsTrimmingClip] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingAudioToDevice, setIsSavingAudioToDevice] = useState(false);
  const [exportFormat, setExportFormat] = useState("mp3");
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [selectedTrackIds, setSelectedTrackIds] = useState([]);

  const [effectSearch, setEffectSearch] = useState("");
  const [onlineEffects, setOnlineEffects] = useState([]);
  const [manualEffects, setManualEffects] = useState([]);
  const [isSearchingEffects, setIsSearchingEffects] = useState(false);
  const [effectsError, setEffectsError] = useState("");
  const [previewingEffectId, setPreviewingEffectId] = useState(null);
  const [openMobilePanel, setOpenMobilePanel] = useState(null);

  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [isPanningTimeline, setIsPanningTimeline] = useState(false);

  const fileInputRef = useRef(null);
  const dragRef = useRef(null);
  const trimRef = useRef(null);
  const timelineRef = useRef(null);
  const playheadRef = useRef(0);
  const rulerPlayheadRef = useRef(null);
  const timelinePlayheadRef = useRef(null);
  const timeDisplayRef = useRef(null);

  const effectFileInputRef = useRef(null);
  const effectBuffersRef = useRef(new Map());
  const previewNodeRef = useRef(null);
  const previewHtmlAudioRef = useRef(null);
  const effectsRef = useRef([]);

  const audioContextRef = useRef(null);
  const activeNodesRef = useRef([]);
  const playbackRef = useRef(null);
  const animationFrameRef = useRef(null);
  const tracksRef = useRef([]);
  const projectAudioEndRef = useRef(0);

  const followPlayheadRef = useRef(true);
  const panRef = useRef(null);
  const suppressAutoScrollRef = useRef(false);
  const suppressAutoScrollTimeoutRef = useRef(null);
  const wheelDeltaXRef = useRef(0);
  const wheelRafRef = useRef(null);
  const pixelsPerSecondRef = useRef(DEFAULT_PIXELS_PER_SECOND);
  const selectedTrackIdsRef = useRef([]);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId);

  const projectAudioEnd = useMemo(() => {
    return tracks.reduce((max, track) => {
      return Math.max(max, track.start + track.duration);
    }, 0);
  }, [tracks]);

  const timelineSeconds = useMemo(() => {
    const maxEnd = tracks.reduce((max, track) => {
      return Math.max(max, track.start + track.duration);
    }, 60);

    return Math.max(90, Math.ceil(maxEnd + 20));
  }, [tracks]);

  const seconds = useMemo(() => {
    return Array.from({ length: timelineSeconds + 1 }, (_, i) => i);
  }, [timelineSeconds]);

  const availableEffects = useMemo(() => {
    return [...manualEffects, ...onlineEffects];
  }, [manualEffects, onlineEffects]);

  useEffect(() => {
    effectsRef.current = availableEffects;
  }, [availableEffects]);

  useEffect(() => {
    followPlayheadRef.current = followPlayhead;
  }, [followPlayhead]);

  useEffect(() => {
    pixelsPerSecondRef.current = pixelsPerSecond;
    updatePlayheadUI(playheadRef.current, false);
  }, [pixelsPerSecond]);

  useEffect(() => {
    selectedTrackIdsRef.current = selectedTrackIds;
  }, [selectedTrackIds]);

  const timelineContentWidth = 160 + timelineSeconds * pixelsPerSecond;

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    projectAudioEndRef.current = projectAudioEnd;
  }, [projectAudioEnd]);

  useEffect(() => {
    const applyDragVisual = (dragData, deltaSeconds) => {
      const visualDeltaPx = deltaSeconds * pixelsPerSecondRef.current;

      dragData.trackIds.forEach((trackId) => {
        const clip = document.querySelector(`[data-track-id="${trackId}"]`);
        if (clip) {
          clip.style.transform = `translateX(${visualDeltaPx}px)`;
        }
      });
    };

    const clearDragVisual = (trackIds) => {
      trackIds.forEach((trackId) => {
        const clip = document.querySelector(`[data-track-id="${trackId}"]`);
        if (clip) {
          clip.style.transform = "";
        }
      });
    };

    const handlePointerMove = (event) => {
      if (trimRef.current) {
        const trimmedTrack = calculateTrimmedTrack(event.clientX, 280);

        if (trimmedTrack) {
          setTracks((prevTracks) =>
            prevTracks.map((track) =>
              track.id === trimmedTrack.id ? trimmedTrack : track
            )
          );
        }

        return;
      }

      if (!dragRef.current) return;

      const dragData = dragRef.current;
      const pps = pixelsPerSecondRef.current;
      const deltaX = event.clientX - dragData.startX;
      const rawDeltaSeconds = deltaX / pps;
      const minInitialStart = Math.min(
        ...Object.values(dragData.initialStarts).map((value) => Number(value) || 0)
      );
      const clampedDeltaSeconds = Math.max(rawDeltaSeconds, -minInitialStart);
      const snappedDeltaSeconds = Math.round(clampedDeltaSeconds * 4) / 4;

      dragData.committedDeltaSeconds = snappedDeltaSeconds;
      dragData.visualDeltaSeconds = clampedDeltaSeconds;

      if (dragData.raf) return;

      dragData.raf = requestAnimationFrame(() => {
        applyDragVisual(dragData, dragData.visualDeltaSeconds || 0);
        dragData.raf = null;
      });
    };

    const handlePointerUp = (event) => {
      if (trimRef.current) {
        const trimmedTrack = calculateTrimmedTrack(event.clientX, 900);

        if (trimmedTrack) {
          setTracks((prevTracks) =>
            prevTracks.map((track) =>
              track.id === trimmedTrack.id ? trimmedTrack : track
            )
          );
        }
      }

      if (dragRef.current) {
        const dragData = dragRef.current;
        const deltaSeconds = dragData.committedDeltaSeconds || 0;

        if (dragData.raf) {
          cancelAnimationFrame(dragData.raf);
        }

        clearDragVisual(dragData.trackIds);

        if (Math.abs(deltaSeconds) > 0) {
          setTracks((prevTracks) =>
            prevTracks.map((track) =>
              dragData.trackIds.includes(track.id)
                ? {
                  ...track,
                  start: Number(
                    ((dragData.initialStarts[track.id] || 0) + deltaSeconds).toFixed(3)
                  ),
                }
                : track
            )
          );
        }
      }

      trimRef.current = null;
      setIsTrimmingClip(false);
      dragRef.current = null;
      setIsDraggingClip(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      stopActiveNodes();
      stopEffectPreview();

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      tracksRef.current.forEach((track) => {
        if (track.url) URL.revokeObjectURL(track.url);
      });

      if (wheelRafRef.current) {
        cancelAnimationFrame(wheelRafRef.current);
      }

      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event) => {
      handleTimelinePanMove(event);
    };

    const handlePointerUp = () => {
      stopTimelinePan();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      if (suppressAutoScrollTimeoutRef.current) {
        clearTimeout(suppressAutoScrollTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const wheelHandler = (event) => {
      handleTimelineWheel(event);
    };

    timeline.addEventListener("wheel", wheelHandler, { passive: false });

    return () => {
      timeline.removeEventListener("wheel", wheelHandler);
      if (wheelRafRef.current) {
        cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
    };
  }, []);

  function getAudioContext() {
    if (!audioContextRef.current) {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      audioContextRef.current = new AudioContextClass();
    }

    return audioContextRef.current;
  }

  function stopActiveNodes() {
    activeNodesRef.current.forEach(({ source }) => {
      try {
        source.stop();
      } catch {
        // La sorgente potrebbe essere già stata fermata.
      }
    });

    activeNodesRef.current = [];
  }

  function getCurrentPlaybackTime() {
    const ctx = audioContextRef.current;
    const playback = playbackRef.current;

    if (!ctx || !playback) return playheadRef.current;

    return playback.timelineStart + (ctx.currentTime - playback.contextStart);
  }

  function updatePlayheadUI(time, syncReactState = false) {
    const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
    playheadRef.current = safeTime;

    const left = `${160 + safeTime * pixelsPerSecondRef.current}px`;

    if (rulerPlayheadRef.current) {
      rulerPlayheadRef.current.style.left = left;
    }

    if (timelinePlayheadRef.current) {
      timelinePlayheadRef.current.style.left = left;
    }

    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = formatPreciseTime(safeTime);
    }

    if (syncReactState) {
      setPlayhead(safeTime);
    }
  }

  function getEnvelopeValue(track, timelineTime) {
    const localTime = timelineTime - track.start;
    const baseVolume = track.volume / 100;

    if (localTime < 0 || localTime > track.duration) return 0;

    let fadeMultiplier = 1;

    if (track.fadeIn > 0 && localTime < track.fadeIn) {
      fadeMultiplier = Math.min(fadeMultiplier, localTime / track.fadeIn);
    }

    if (track.fadeOut > 0 && localTime > track.duration - track.fadeOut) {
      const remaining = track.duration - localTime;
      fadeMultiplier = Math.min(fadeMultiplier, remaining / track.fadeOut);
    }

    return Math.max(0, Math.min(1, fadeMultiplier)) * baseVolume;
  }

  function scheduleGainEnvelope(gainNode, track, playFromTime, contextNow) {
    const gain = gainNode.gain;
    const baseVolume = track.volume / 100;
    const trackStart = track.start;
    const trackEnd = track.start + track.duration;
    const fadeInEnd = track.start + track.fadeIn;
    const fadeOutStart = trackEnd - track.fadeOut;

    const ctxTimeFromTimeline = (timelineTime) => {
      return contextNow + (timelineTime - playFromTime);
    };

    const startGain = getEnvelopeValue(track, Math.max(playFromTime, trackStart));

    gain.setValueAtTime(startGain, contextNow);

    if (track.fadeIn > 0 && fadeInEnd > playFromTime) {
      const fadeTargetTime = ctxTimeFromTimeline(fadeInEnd);

      gain.linearRampToValueAtTime(baseVolume, Math.max(contextNow, fadeTargetTime));
    }

    if (track.fadeOut > 0 && trackEnd > playFromTime) {
      const fadeStartContextTime = ctxTimeFromTimeline(fadeOutStart);
      const fadeEndContextTime = ctxTimeFromTimeline(trackEnd);

      if (fadeOutStart > playFromTime) {
        gain.setValueAtTime(baseVolume, Math.max(contextNow, fadeStartContextTime));
      }

      gain.linearRampToValueAtTime(0, Math.max(contextNow, fadeEndContextTime));
    }
  }

  function scheduleOfflineGainEnvelope(gainNode, track, durationToPlay) {
    const gain = gainNode.gain;
    const trackStart = Math.max(0, track.start || 0);
    const safeDuration = Math.max(MIN_CLIP_DURATION, durationToPlay || track.duration || 0);
    const trackEnd = trackStart + safeDuration;
    const baseVolume = Math.max(0, Math.min(1, (track.volume ?? 100) / 100));
    const fadeIn = Math.max(0, Math.min(track.fadeIn || 0, safeDuration));
    const fadeOut = Math.max(0, Math.min(track.fadeOut || 0, safeDuration));

    gain.cancelScheduledValues(0);
    gain.setValueAtTime(0, 0);

    if (fadeIn > 0) {
      gain.setValueAtTime(0, trackStart);
      gain.linearRampToValueAtTime(baseVolume, trackStart + fadeIn);
    } else {
      gain.setValueAtTime(baseVolume, trackStart);
    }

    if (fadeOut > 0) {
      const fadeOutStart = Math.max(trackStart, trackEnd - fadeOut);
      gain.setValueAtTime(baseVolume, fadeOutStart);
      gain.linearRampToValueAtTime(0, trackEnd);
    } else {
      gain.setValueAtTime(baseVolume, trackEnd);
    }
  }

  async function renderProjectToAudioBuffer() {
    const currentTracks = getAudibleTracks(tracksRef.current).filter(
      (track) => track.audioBuffer && track.duration > 0
    );

    if (currentTracks.length === 0) {
      throw new Error("Non ci sono tracce da esportare.");
    }

    const projectEnd = currentTracks.reduce((max, track) => {
      return Math.max(max, (track.start || 0) + (track.duration || 0));
    }, 0);

    if (projectEnd <= 0) {
      throw new Error("La durata del progetto non è valida.");
    }

    const sampleRate = currentTracks[0]?.audioBuffer?.sampleRate || 44100;
    const numberOfChannels = Math.min(
      2,
      Math.max(
        1,
        ...currentTracks.map((track) => track.audioBuffer.numberOfChannels || 1)
      )
    );
    const totalLength = Math.ceil((projectEnd + 0.25) * sampleRate);
    const offlineContext = new OfflineAudioContext(
      numberOfChannels,
      totalLength,
      sampleRate
    );

    currentTracks.forEach((track) => {
      const sourceStart = Math.max(0, track.sourceStart || 0);
      const availableDuration = Math.max(
        0,
        track.audioBuffer.duration - sourceStart
      );
      const durationToPlay = Math.min(track.duration, availableDuration);

      if (durationToPlay <= 0) return;

      const source = offlineContext.createBufferSource();
      const gainNode = offlineContext.createGain();

      source.buffer = track.audioBuffer;
      source.connect(gainNode);
      gainNode.connect(offlineContext.destination);

      scheduleOfflineGainEnvelope(gainNode, track, durationToPlay);

      try {
        source.start(Math.max(0, track.start || 0), sourceStart, durationToPlay);
      } catch (error) {
        console.error("Errore render traccia:", track.name, error);
      }
    });

    const renderedBuffer = await offlineContext.startRendering();
    normalizeRenderedBuffer(renderedBuffer);

    return renderedBuffer;
  }

  async function createProjectAudioExport(format = exportFormat) {
    const normalizedFormat = format === "wav" ? "wav" : "mp3";
    const renderedBuffer = await renderProjectToAudioBuffer();

    if (normalizedFormat === "wav") {
      return {
        blob: audioBufferToWavBlob(renderedBuffer),
        extension: "wav",
        mimeType: "audio/wav",
      };
    }

    return {
      blob: await audioBufferToMp3Blob(renderedBuffer, 192),
      extension: "mp3",
      mimeType: "audio/mpeg",
    };
  }

  function serializeTrackForProject(track) {
    const hasBlob = track.file instanceof Blob;
    const isRemoteUrl = typeof track.url === "string" && !track.url.startsWith("blob:");

    return {
      id: track.id,
      name: track.name,
      start: track.start,
      duration: track.duration,
      sourceStart: track.sourceStart || 0,
      volume: track.volume ?? 100,
      fadeIn: track.fadeIn || 0,
      fadeOut: track.fadeOut || 0,
      color: track.color || "blue",
      type: track.type || "audio",
      effectId: track.effectId || null,
      sourceUrl: track.sourceUrl || null,
      license: track.license || null,
      licenseUrl: track.licenseUrl || null,
      creator: track.creator || null,
      muted: !!track.muted,
      solo: !!track.solo,
      sourceKind: hasBlob ? "blob" : isRemoteUrl ? "url" : "unknown",
      url: isRemoteUrl ? track.url : null,
      blob: hasBlob ? track.file : null,
    };
  }

  function serializeEffectForProject(effect) {
    const hasBlob = effect.rawFile instanceof Blob;
    const isRemoteUrl = typeof effect.file === "string" && !effect.file.startsWith("blob:");

    return {
      id: effect.id,
      name: effect.name,
      category: effect.category,
      creator: effect.creator || null,
      license: effect.license || null,
      licenseUrl: effect.licenseUrl || null,
      sourceUrl: effect.sourceUrl || null,
      duration: effect.duration || null,
      type: effect.type || "manual-effect",
      sourceKind: hasBlob ? "blob" : isRemoteUrl ? "url" : "unknown",
      file: isRemoteUrl ? effect.file : null,
      blob: hasBlob ? effect.rawFile : null,
    };
  }

  async function restoreAudioBufferFromProjectItem(item) {
    const ctx = getAudioContext();

    if (item.sourceKind === "blob" && item.blob) {
      const arrayBuffer = await item.blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const url = URL.createObjectURL(item.blob);

      return { audioBuffer, url, file: item.blob };
    }

    if (item.sourceKind === "url" && item.url) {
      const audioBuffer = await loadAudioBufferFromUrl(item.url);
      return { audioBuffer, url: item.url, file: null };
    }

    if (item.sourceKind === "url" && item.file) {
      const audioBuffer = await loadAudioBufferFromUrl(item.file);
      return { audioBuffer, url: item.file, file: null };
    }

    throw new Error("Sorgente audio non disponibile nel progetto salvato.");
  }

  async function saveProjectInBrowser() {
    if (tracksRef.current.length === 0 && manualEffects.length === 0 && onlineEffects.length === 0) {
      alert("Non ci sono ancora dati da salvare nel progetto.");
      return;
    }

    setIsSavingProject(true);

    try {
      const project = {
        id: DEFAULT_PROJECT_ID,
        savedAt: new Date().toISOString(),
        pixelsPerSecond,
        tracks: tracksRef.current.map(serializeTrackForProject),
        manualEffects: manualEffects.map(serializeEffectForProject),
        onlineEffects: onlineEffects.map(serializeEffectForProject),
      };

      await saveProjectRecord(project);
      alert("Progetto salvato nel browser.");
    } catch (error) {
      console.error("Errore salvataggio progetto:", error);
      alert("Non riesco a salvare il progetto. Se i file audio sono molto grandi, prova a ridurre il numero di tracce.");
    } finally {
      setIsSavingProject(false);
    }
  }

  async function loadProjectFromBrowser() {
    setIsLoadingProject(true);

    try {
      const project = await loadProjectRecord();

      if (!project) {
        alert("Non ho trovato nessun progetto salvato in questo browser.");
        return;
      }

      if (isPlaying) {
        pausePlayback();
      }

      stopEffectPreview();

      tracksRef.current.forEach((track) => {
        if (track.url?.startsWith("blob:")) {
          URL.revokeObjectURL(track.url);
        }
      });

      const restoredEffects = [];
      for (const effect of project.manualEffects || []) {
        try {
          const restored = await restoreAudioBufferFromProjectItem(effect);
          restoredEffects.push({
            ...effect,
            file: restored.url,
            rawFile: restored.file,
            audioBuffer: restored.audioBuffer,
            waveformPeaks: buildWaveformPeaks(restored.audioBuffer),
          });
        } catch (error) {
          console.warn("Effetto non ripristinato:", effect.name, error);
        }
      }

      const restoredOnlineEffects = [];
      for (const effect of project.onlineEffects || []) {
        restoredOnlineEffects.push({
          ...effect,
          file: effect.file || effect.url,
        });
      }

      const restoredTracks = [];
      for (const track of project.tracks || []) {
        try {
          const restored = await restoreAudioBufferFromProjectItem(track);
          restoredTracks.push({
            ...track,
            file: restored.file,
            url: restored.url,
            audioBuffer: restored.audioBuffer,
            waveformPeaks: buildWaveformPeaks(
              restored.audioBuffer,
              900,
              track.sourceStart || 0,
              track.duration
            ),
          });
        } catch (error) {
          console.warn("Traccia non ripristinata:", track.name, error);
        }
      }

      setPixelsPerSecond(project.pixelsPerSecond || DEFAULT_PIXELS_PER_SECOND);
      setManualEffects(restoredEffects);
      setOnlineEffects(restoredOnlineEffects);
      setTracks(restoredTracks);
      setSelectedTrackId(restoredTracks[0]?.id || null);
      setSelectedTrackIds(restoredTracks[0]?.id ? [restoredTracks[0].id] : []);
      updatePlayheadUI(0, true);
    } catch (error) {
      console.error("Errore caricamento progetto:", error);
      alert("Non riesco a caricare il progetto salvato.");
    } finally {
      setIsLoadingProject(false);
    }
  }

  async function exportProjectAudio(format = exportFormat) {
    if (tracksRef.current.length === 0 || isExporting || isSavingAudioToDevice) return;

    if (isPlaying) {
      pausePlayback();
    }

    stopEffectPreview();
    setIsExporting(true);

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const { blob, extension } = await createProjectAudioExport(format);
      const fileName = makeExportFileName(extension);

      downloadBlob(blob, fileName);
    } catch (error) {
      console.error("Errore export audio:", error);
      alert(
        format === "mp3"
          ? "Non riesco a esportare in MP3. Controlla di aver installato @breezystack/lamejs e che ci siano tracce valide."
          : "Non riesco a esportare il progetto. Controlla che ci siano tracce valide nella timeline."
      );
    } finally {
      setIsExporting(false);
    }
  }

  async function saveProjectAudioToDevice(format = exportFormat) {
    if (tracksRef.current.length === 0 || isExporting || isSavingAudioToDevice) return;

    if (isPlaying) {
      pausePlayback();
    }

    stopEffectPreview();
    setIsSavingAudioToDevice(true);

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const { blob, extension, mimeType } = await createProjectAudioExport(format);
      const fileName = makeExportFileName(extension);
      const result = await saveBlobToDevice(blob, fileName, mimeType, extension);

      if (result === "download") {
        alert("Il browser non consente il salvataggio diretto in una cartella: ho avviato il download del file.");
      }
    } catch (error) {
      console.error("Errore salvataggio audio:", error);
      alert(
        format === "mp3"
          ? "Non riesco a salvare in MP3. Controlla di aver installato @breezystack/lamejs e che ci siano tracce valide."
          : "Non riesco a salvare il file audio sul dispositivo."
      );
    } finally {
      setIsSavingAudioToDevice(false);
    }
  }

  async function playFromCurrentPosition() {
    if (tracks.length === 0) return;

    const ctx = getAudioContext();

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    stopActiveNodes();

    let startTime = playheadRef.current;

    if (startTime >= projectAudioEndRef.current) {
      startTime = 0;
      updatePlayheadUI(0, true);
    }

    const contextNow = ctx.currentTime;

    getAudibleTracks(tracksRef.current).forEach((track) => {
      const trackEnd = track.start + track.duration;

      if (startTime >= trackEnd) return;

      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();

      source.buffer = track.audioBuffer;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      const startsInFuture = track.start > startTime;
      const when = startsInFuture ? contextNow + (track.start - startTime) : contextNow;
      const clipLocalOffset = startsInFuture ? 0 : startTime - track.start;
      const sourceOffset = (track.sourceStart || 0) + clipLocalOffset;
      const durationToPlay = Math.max(0.01, track.duration - clipLocalOffset);

      scheduleGainEnvelope(gainNode, track, startTime, contextNow);

      try {
        source.start(when, sourceOffset, durationToPlay);
        activeNodesRef.current.push({ source, gainNode });
      } catch (error) {
        console.error("Errore riproduzione traccia:", error);
      }
    });

    playbackRef.current = {
      contextStart: contextNow,
      timelineStart: startTime,
    };

    setIsPlaying(true);
    startPlayheadAnimation();
  }

  function startPlayheadAnimation() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const tick = () => {
      const ctx = audioContextRef.current;
      const playback = playbackRef.current;

      if (!ctx || !playback) return;

      const currentTime =
        playback.timelineStart + (ctx.currentTime - playback.contextStart);

      const safeTime = Math.min(currentTime, projectAudioEndRef.current || currentTime);
      updatePlayheadUI(safeTime);
      scrollTimelineToPlayhead(safeTime);

      if (projectAudioEndRef.current > 0 && currentTime >= projectAudioEndRef.current) {
        stopPlayback();
        return;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
  }

  function pausePlayback() {
    const currentTime = getCurrentPlaybackTime();

    stopActiveNodes();

    playbackRef.current = null;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    updatePlayheadUI(Math.max(0, currentTime), true);
    setIsPlaying(false);
  }

  function stopPlayback() {
    stopActiveNodes();

    playbackRef.current = null;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    updatePlayheadUI(0, true);
    setIsPlaying(false);
  }

  function togglePlayback() {
    if (isPlaying) {
      pausePlayback();
    } else {
      playFromCurrentPosition();
    }
  }

  async function handleAudioFiles(fileList) {
    const files = Array.from(fileList).filter(isAudioFile);

    if (files.length === 0) return;

    setIsImporting(true);

    const ctx = getAudioContext();
    const newTracks = [];
    const baseIndex = tracksRef.current.length;

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const waveformPeaks = buildWaveformPeaks(audioBuffer);
        const url = URL.createObjectURL(file);

        newTracks.push({
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^/.]+$/, ""),
          file,
          url,
          audioBuffer,
          waveformPeaks,
          sourceStart: 0,
          start: 0,
          duration: audioBuffer.duration,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
          color: clipColors[(baseIndex + newTracks.length) % clipColors.length],
          muted: false,
          solo: false,
        });
      } catch (error) {
        console.error("Errore import audio:", error);
      }
    }

    setTracks((prevTracks) => [...prevTracks, ...newTracks]);

    if (!selectedTrackId && newTracks.length > 0) {
      setSelectedTrackId(newTracks[0].id);
      setSelectedTrackIds([newTracks[0].id]);
    }

    setIsImporting(false);
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleInputChange(event) {
    handleAudioFiles(event.target.files);
    event.target.value = "";
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDraggingOver(false);
    handleAudioFiles(event.dataTransfer.files);
  }

  function handleDragOver(event) {
    event.preventDefault();
    setIsDraggingOver(true);
  }

  function handleDragLeave() {
    setIsDraggingOver(false);
  }

  function selectOnlyTrack(trackId) {
    setSelectedTrackId(trackId);
    setSelectedTrackIds(trackId ? [trackId] : []);
  }

  function toggleTrackSelection(trackId) {
    setSelectedTrackId(trackId);
    setSelectedTrackIds((prevIds) => {
      if (prevIds.includes(trackId)) {
        const nextIds = prevIds.filter((id) => id !== trackId);
        if (nextIds.length === 0) {
          setSelectedTrackId(null);
        }
        return nextIds;
      }

      return [...prevIds, trackId];
    });
  }

  function handleTrackClick(event, track) {
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      toggleTrackSelection(track.id);
      return;
    }

    selectOnlyTrack(track.id);
  }

  function handleClipPointerDown(event, track) {
    event.preventDefault();
    event.stopPropagation();

    if (event.target.closest(".trim-handle")) return;

    if (isPlaying) {
      pausePlayback();
    }

    const currentSelection = selectedTrackIdsRef.current;
    let nextSelection = currentSelection;

    if (event.ctrlKey || event.metaKey) {
      nextSelection = currentSelection.includes(track.id)
        ? currentSelection.filter((id) => id !== track.id)
        : [...currentSelection, track.id];

      if (nextSelection.length === 0) {
        setSelectedTrackId(null);
        setSelectedTrackIds([]);
        return;
      }
    } else if (!currentSelection.includes(track.id)) {
      nextSelection = [track.id];
    }

    if (!nextSelection.includes(track.id)) {
      nextSelection = [track.id];
    }

    setSelectedTrackId(track.id);
    setSelectedTrackIds(nextSelection);
    setIsDraggingClip(true);

    const initialStarts = {};
    tracksRef.current.forEach((item) => {
      if (nextSelection.includes(item.id)) {
        initialStarts[item.id] = item.start || 0;
      }
    });

    dragRef.current = {
      trackIds: nextSelection,
      startX: event.clientX,
      initialStarts,
      committedDeltaSeconds: 0,
      visualDeltaSeconds: 0,
      raf: null,
    };
  }

  function zoomInTimeline() {
    setPixelsPerSecond((value) =>
      Math.min(MAX_PIXELS_PER_SECOND, Math.round(value * 1.25))
    );
  }

  function zoomOutTimeline() {
    setPixelsPerSecond((value) =>
      Math.max(MIN_PIXELS_PER_SECOND, Math.round(value / 1.25))
    );
  }

  function getAudibleTracks(trackList) {
    const hasSolo = trackList.some((track) => track.solo);

    return trackList.filter((track) => {
      if (track.muted) return false;
      if (hasSolo) return track.solo;
      return true;
    });
  }

  function toggleTrackFlag(trackId, flag) {
    setTracks((prevTracks) =>
      prevTracks.map((track) =>
        track.id === trackId
          ? {
            ...track,
            [flag]: !track[flag],
          }
          : track
      )
    );
  }


  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function calculateTrimmedTrack(clientX, waveformSamples = 900) {
    if (!trimRef.current) return null;

    const {
      track,
      edge,
      startX,
      initialStart,
      initialSourceStart,
      initialDuration,
    } = trimRef.current;

    const rawDeltaSeconds = (clientX - startX) / pixelsPerSecondRef.current;
    const snappedDeltaSeconds = Math.round(rawDeltaSeconds * 4) / 4;
    const originalDuration = track.audioBuffer?.duration || initialDuration;

    let nextStart = initialStart;
    let nextSourceStart = initialSourceStart;
    let nextDuration = initialDuration;

    if (edge === "left") {
      const minDelta = Math.max(-initialSourceStart, -initialStart);
      const maxDelta = initialDuration - MIN_CLIP_DURATION;
      const delta = clamp(snappedDeltaSeconds, minDelta, maxDelta);

      nextStart = Number((initialStart + delta).toFixed(3));
      nextSourceStart = Number((initialSourceStart + delta).toFixed(3));
      nextDuration = Number((initialDuration - delta).toFixed(3));
    }

    if (edge === "right") {
      const minDelta = MIN_CLIP_DURATION - initialDuration;
      const maxDelta = originalDuration - (initialSourceStart + initialDuration);
      const delta = clamp(snappedDeltaSeconds, minDelta, maxDelta);

      nextDuration = Number((initialDuration + delta).toFixed(3));
    }

    nextDuration = Math.max(MIN_CLIP_DURATION, nextDuration);

    return {
      ...track,
      start: nextStart,
      sourceStart: nextSourceStart,
      duration: nextDuration,
      fadeIn: Math.min(track.fadeIn || 0, nextDuration),
      fadeOut: Math.min(track.fadeOut || 0, nextDuration),
      waveformPeaks: buildWaveformPeaks(
        track.audioBuffer,
        waveformSamples,
        nextSourceStart,
        nextDuration
      ),
    };
  }

  function handleTrimPointerDown(event, track, edge) {
    event.preventDefault();
    event.stopPropagation();

    if (isPlaying) {
      pausePlayback();
    }

    setSelectedTrackId(track.id);
    setIsTrimmingClip(true);

    trimRef.current = {
      track,
      edge,
      startX: event.clientX,
      initialStart: track.start,
      initialSourceStart: track.sourceStart || 0,
      initialDuration: track.duration,
    };
  }

  function handleTimelinePointerDown(event) {
    if (event.target.closest(".audio-clip")) return;
    if (!timelineRef.current) return;

    const wantsPan = event.shiftKey || event.button === 1;

    if (wantsPan) {
      event.preventDefault();
      startTimelinePan(event);
      return;
    }

    const rect = timelineRef.current.getBoundingClientRect();

    const x =
      event.clientX -
      rect.left +
      timelineRef.current.scrollLeft -
      160;

    if (x < 0) return;

    const newTime = Math.max(0, x / pixelsPerSecondRef.current);
    const snappedTime = Math.round(newTime * 4) / 4;

    seekToTimelineTime(snappedTime);
  }

  function updateSelectedTrack(field, value) {
    if (!selectedTrackId) return;

    setTracks((prevTracks) =>
      prevTracks.map((track) =>
        track.id === selectedTrackId
          ? {
            ...track,
            [field]: value,
          }
          : track
      )
    );
  }

  function deleteSelectedTrack() {
    const idsToDelete = selectedTrackIdsRef.current.length > 0
      ? selectedTrackIdsRef.current
      : selectedTrack
        ? [selectedTrack.id]
        : [];

    if (idsToDelete.length === 0) return;

    if (isPlaying) {
      pausePlayback();
    }

    tracksRef.current.forEach((track) => {
      if (idsToDelete.includes(track.id) && track.url?.startsWith("blob:")) {
        URL.revokeObjectURL(track.url);
      }
    });

    setTracks((prevTracks) =>
      prevTracks.filter((track) => !idsToDelete.includes(track.id))
    );

    setSelectedTrackId(null);
    setSelectedTrackIds([]);
  }


  function duplicateSelectedTracks() {
    const idsToDuplicate = selectedTrackIdsRef.current.length > 0
      ? selectedTrackIdsRef.current
      : selectedTrack
        ? [selectedTrack.id]
        : [];

    if (idsToDuplicate.length === 0) return;

    if (isPlaying) {
      pausePlayback();
    }

    const duplicatedTracks = tracksRef.current
      .filter((track) => idsToDuplicate.includes(track.id))
      .map((track, index) => ({
        ...track,
        id: crypto.randomUUID(),
        name: `${track.name} copia`,
        start: Number(((track.start || 0) + 0.5 + index * 0.05).toFixed(3)),
        waveformPeaks: [...(track.waveformPeaks || [])],
      }));

    if (duplicatedTracks.length === 0) return;

    const duplicatedIds = duplicatedTracks.map((track) => track.id);

    setTracks((prevTracks) => [...prevTracks, ...duplicatedTracks]);
    setSelectedTrackId(duplicatedIds[0]);
    setSelectedTrackIds(duplicatedIds);
  }

  function getTrackToSplit() {
    const currentTime = playheadRef.current;

    if (selectedTrack) {
      const localTime = currentTime - selectedTrack.start;

      if (localTime > 0.08 && localTime < selectedTrack.duration - 0.08) {
        return selectedTrack;
      }
    }

    return tracksRef.current.find((track) => {
      const localTime = currentTime - track.start;
      return localTime > 0.08 && localTime < track.duration - 0.08;
    });
  }

  function splitClipAtPlayhead() {
    const trackToSplit = getTrackToSplit();
    const currentTime = playheadRef.current;

    if (!trackToSplit) {
      alert(
        "Posiziona la testina rossa dentro una clip e selezionala, poi premi Taglia."
      );
      return;
    }

    const localSplitTime = currentTime - trackToSplit.start;

    if (localSplitTime <= 0.08 || localSplitTime >= trackToSplit.duration - 0.08) {
      alert("La testina è troppo vicina all'inizio o alla fine della clip.");
      return;
    }

    if (isPlaying) {
      pausePlayback();
    }

    const sourceStart = trackToSplit.sourceStart || 0;
    const leftDuration = Number(localSplitTime.toFixed(3));
    const rightDuration = Number((trackToSplit.duration - localSplitTime).toFixed(3));

    const leftTrack = {
      ...trackToSplit,
      duration: leftDuration,
      fadeIn: Math.min(trackToSplit.fadeIn, leftDuration),
      fadeOut: Math.min(trackToSplit.fadeOut, leftDuration),
      waveformPeaks: buildWaveformPeaks(
        trackToSplit.audioBuffer,
        900,
        sourceStart,
        leftDuration
      ),
    };

    const rightTrack = {
      ...trackToSplit,
      id: crypto.randomUUID(),
      name: `${trackToSplit.name} · cut`,
      start: Number(currentTime.toFixed(3)),
      sourceStart: Number((sourceStart + localSplitTime).toFixed(3)),
      duration: rightDuration,
      fadeIn: Math.min(trackToSplit.fadeIn, rightDuration),
      fadeOut: Math.min(trackToSplit.fadeOut, rightDuration),
      waveformPeaks: buildWaveformPeaks(
        trackToSplit.audioBuffer,
        900,
        sourceStart + localSplitTime,
        rightDuration
      ),
    };

    setTracks((prevTracks) =>
      prevTracks.flatMap((track) =>
        track.id === trackToSplit.id ? [leftTrack, rightTrack] : [track]
      )
    );

    setSelectedTrackId(rightTrack.id);
    setSelectedTrackIds([rightTrack.id]);
  }

  async function loadAudioBufferFromUrl(url) {
    const ctx = getAudioContext();

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Impossibile caricare il file audio: ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  async function getEffectAudioBuffer(effect) {
    if (effect.audioBuffer) {
      return effect.audioBuffer;
    }

    if (effectBuffersRef.current.has(effect.id)) {
      return effectBuffersRef.current.get(effect.id);
    }

    const audioBuffer = await loadAudioBufferFromUrl(effect.file);
    effectBuffersRef.current.set(effect.id, audioBuffer);

    return audioBuffer;
  }

  function stopEffectPreview() {
    if (previewNodeRef.current) {
      try {
        previewNodeRef.current.stop();
        previewNodeRef.current.disconnect?.();
      } catch {
        // Anteprima già terminata.
      }

      previewNodeRef.current = null;
    }

    if (previewHtmlAudioRef.current) {
      previewHtmlAudioRef.current.pause();
      previewHtmlAudioRef.current.src = "";
      previewHtmlAudioRef.current.load?.();
      previewHtmlAudioRef.current = null;
    }

    setPreviewingEffectId(null);
  }

  async function previewEffect(effect) {
    if (previewingEffectId === effect.id) {
      stopEffectPreview();
      return;
    }

    stopEffectPreview();
    setPreviewingEffectId(effect.id);

    try {
      const ctx = getAudioContext();

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const audioBuffer = await getEffectAudioBuffer(effect);
      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();

      source.buffer = audioBuffer;
      gainNode.gain.value = 0.9;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      source.start();
      previewNodeRef.current = source;

      source.onended = () => {
        if (previewNodeRef.current === source) {
          previewNodeRef.current = null;
          setPreviewingEffectId(null);
        }
      };
    } catch (webAudioError) {
      try {
        const audio = new Audio(effect.file);
        audio.volume = 0.9;
        audio.preload = "auto";

        previewHtmlAudioRef.current = audio;

        audio.onended = () => {
          if (previewHtmlAudioRef.current === audio) {
            previewHtmlAudioRef.current = null;
            setPreviewingEffectId(null);
          }
        };

        audio.onerror = () => {
          if (previewHtmlAudioRef.current === audio) {
            previewHtmlAudioRef.current = null;
            setPreviewingEffectId(null);
          }
        };

        await audio.play();
      } catch (htmlAudioError) {
        console.error("Errore anteprima effetto:", webAudioError, htmlAudioError);
        setPreviewingEffectId(null);
        alert(
          `Non riesco a riprodurre "${effect.name}". Alcuni file online possono essere bloccati dal browser. In quel caso scaricalo e importalo manualmente.`
        );
      }
    }
  }

  async function searchOnlineEffects(queryValue = effectSearch) {
    const query = queryValue.trim();

    if (!query) return;

    setIsSearchingEffects(true);
    setEffectsError("");

    try {
      const params = new URLSearchParams({
        q: `${query} sound effect`,
        page_size: "18",
      });

      const response = await fetch(
        `https://api.openverse.org/v1/audio/?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error("Errore ricerca Openverse");
      }

      const data = await response.json();

      const results = (data.results || [])
        .filter((item) => item.url)
        .map((item) => ({
          id: `online-${item.id}`,
          name: item.title || "Effetto online",
          category: item.source || "Openverse",
          file: item.url,
          creator: item.creator || "Autore sconosciuto",
          license: item.license || "Licenza non indicata",
          licenseUrl: item.license_url,
          sourceUrl: item.foreign_landing_url,
          duration: item.duration || null,
          type: "online-effect",
        }));

      setOnlineEffects(results);

      if (results.length === 0) {
        setEffectsError("Nessun effetto trovato. Prova con parole inglesi tipo whoosh, impact, riser, applause.");
      }
    } catch (error) {
      console.error("Errore ricerca effetti:", error);
      setEffectsError("Ricerca online non riuscita. Riprova tra poco.");
    } finally {
      setIsSearchingEffects(false);
    }
  }

  async function handleManualEffectFiles(fileList) {
    const files = Array.from(fileList).filter(isAudioFile);

    if (files.length === 0) return;

    const ctx = getAudioContext();
    const newEffects = [];

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const url = URL.createObjectURL(file);

        newEffects.push({
          id: `manual-${crypto.randomUUID()}`,
          name: file.name.replace(/\.[^/.]+$/, ""),
          category: "Importato",
          file: url,
          rawFile: file,
          audioBuffer,
          waveformPeaks: buildWaveformPeaks(audioBuffer),
          sourceStart: 0,
          duration: audioBuffer.duration,
          type: "manual-effect",
        });
      } catch (error) {
        console.error("Errore import effetto:", error);
      }
    }

    setManualEffects((prevEffects) => [...prevEffects, ...newEffects]);
  }

  function handleEffectFileInputChange(event) {
    handleManualEffectFiles(event.target.files);
    event.target.value = "";
  }

  function handleEffectDragStart(event, effect) {
    event.dataTransfer.setData("application/audio-effect-id", effect.id);
    event.dataTransfer.effectAllowed = "copy";
  }

  function getTimelineDropTime(event) {
    if (!timelineRef.current) return 0;

    const rect = timelineRef.current.getBoundingClientRect();

    const x =
      event.clientX -
      rect.left +
      timelineRef.current.scrollLeft -
      160;

    const rawTime = Math.max(0, x / pixelsPerSecondRef.current);

    return Math.round(rawTime * 4) / 4;
  }

  async function addEffectToTimeline(effect, startAt) {
    try {
      const audioBuffer = await getEffectAudioBuffer(effect);

      const newTrack = {
        id: crypto.randomUUID(),
        name: effect.name,
        file: effect.rawFile || null,
        url: effect.file,
        audioBuffer,
        waveformPeaks: effect.waveformPeaks || buildWaveformPeaks(audioBuffer),
        sourceStart: effect.sourceStart || 0,
        start: startAt,
        duration: audioBuffer.duration,
        volume: 100,
        fadeIn: 0,
        fadeOut: 0,
        color: "pink",
        type: "effect",
        effectId: effect.id,
        sourceUrl: effect.sourceUrl,
        license: effect.license,
        licenseUrl: effect.licenseUrl,
        creator: effect.creator,
        muted: false,
        solo: false,
      };

      setTracks((prevTracks) => [...prevTracks, newTrack]);
      setSelectedTrackId(newTrack.id);
      setSelectedTrackIds([newTrack.id]);
    } catch (error) {
      console.error("Errore aggiunta effetto:", error);
      alert(
        `Non riesco ad aggiungere "${effect.name}". Alcuni file online possono essere bloccati dal browser. Scaricalo e importalo manualmente.`
      );
    }
  }

  function toggleMobilePanel(panelName) {
    setOpenMobilePanel((currentPanel) =>
      currentPanel === panelName ? null : panelName
    );
  }

  function getEffectInsertTime() {
    const currentTime = playheadRef.current || playhead || 0;
    return Math.round(Math.max(0, currentTime) * 4) / 4;
  }

  async function addEffectFromPanel(effect) {
    await addEffectToTimeline(effect, getEffectInsertTime());

    if (window.matchMedia("(max-width: 800px)").matches) {
      setOpenMobilePanel(null);
    }
  }

  async function handleTimelineDrop(event) {
    event.preventDefault();
    setIsDraggingOver(false);

    const effectId = event.dataTransfer.getData("application/audio-effect-id");

    if (effectId) {
      const effect = effectsRef.current.find((item) => item.id === effectId);

      if (!effect) return;

      const startAt = getTimelineDropTime(event);

      await addEffectToTimeline(effect, startAt);
      return;
    }

    if (event.dataTransfer.files?.length > 0) {
      await handleAudioFiles(event.dataTransfer.files);
    }
  }

  function temporarilyDisableAutoScroll(duration = 1200) {
    suppressAutoScrollRef.current = true;

    if (suppressAutoScrollTimeoutRef.current) {
      clearTimeout(suppressAutoScrollTimeoutRef.current);
    }

    suppressAutoScrollTimeoutRef.current = setTimeout(() => {
      suppressAutoScrollRef.current = false;
    }, duration);
  }


  function scrollTimelineToPlayhead(currentTime) {
    if (!timelineRef.current) return;
    if (!followPlayheadRef.current) return;
    if (suppressAutoScrollRef.current) return;

    const timeline = timelineRef.current;
    const playheadX = 160 + currentTime * pixelsPerSecondRef.current;

    const visibleStart = timeline.scrollLeft;
    const visibleEnd = timeline.scrollLeft + timeline.clientWidth;

    const safeLeft = visibleStart + timeline.clientWidth * 0.25;
    const safeRight = visibleStart + timeline.clientWidth * 0.75;

    if (playheadX > safeRight) {
      timeline.scrollLeft = playheadX - timeline.clientWidth * 0.45;
    }

    if (playheadX < safeLeft) {
      timeline.scrollLeft = Math.max(0, playheadX - timeline.clientWidth * 0.25);
    }
  }

  function seekToTimelineTime(newTime) {
    const safeTime = Math.max(0, Math.min(newTime, projectAudioEndRef.current || newTime));

    if (isPlaying) {
      stopActiveNodes();

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      updatePlayheadUI(safeTime, true);

      const ctx = getAudioContext();
      const contextNow = ctx.currentTime;

      getAudibleTracks(tracksRef.current).forEach((track) => {
        const trackEnd = track.start + track.duration;

        if (safeTime >= trackEnd) return;

        const source = ctx.createBufferSource();
        const gainNode = ctx.createGain();

        source.buffer = track.audioBuffer;

        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        const startsInFuture = track.start > safeTime;
        const when = startsInFuture
          ? contextNow + (track.start - safeTime)
          : contextNow;

        const clipLocalOffset = startsInFuture ? 0 : safeTime - track.start;
        const sourceOffset = (track.sourceStart || 0) + clipLocalOffset;
        const durationToPlay = Math.max(0.01, track.duration - clipLocalOffset);

        scheduleGainEnvelope(gainNode, track, safeTime, contextNow);

        try {
          source.start(when, sourceOffset, durationToPlay);
          activeNodesRef.current.push({ source, gainNode });
        } catch (error) {
          console.error("Errore seek traccia:", error);
        }
      });

      playbackRef.current = {
        contextStart: contextNow,
        timelineStart: safeTime,
      };

      startPlayheadAnimation();
      return;
    }

    updatePlayheadUI(safeTime, true);
  }

  function handleTimelineWheel(event) {
    if (!timelineRef.current) return;

    const deltaX = event.deltaX || 0;
    const deltaY = event.deltaY || 0;

    // La rotellina verticale viene trasformata in scroll orizzontale.
    // Il movimento viene applicato con requestAnimationFrame per evitare lag.
    const horizontalDelta = deltaX + deltaY;

    if (horizontalDelta === 0) return;

    event.preventDefault();
    temporarilyDisableAutoScroll(900);

    wheelDeltaXRef.current += horizontalDelta;

    if (wheelRafRef.current) return;

    wheelRafRef.current = requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollLeft += wheelDeltaXRef.current;
      }

      wheelDeltaXRef.current = 0;
      wheelRafRef.current = null;
    });
  }


  function startTimelinePan(event) {
    if (!timelineRef.current) return;

    panRef.current = {
      startX: event.clientX,
      startScrollLeft: timelineRef.current.scrollLeft,
    };

    setIsPanningTimeline(true);
    temporarilyDisableAutoScroll(900);
  }

  function handleTimelinePanMove(event) {
    if (!panRef.current || !timelineRef.current) return;

    const deltaX = event.clientX - panRef.current.startX;

    timelineRef.current.scrollLeft = panRef.current.startScrollLeft - deltaX;
    temporarilyDisableAutoScroll(900);
  }

  function stopTimelinePan() {
    panRef.current = null;
    setIsPanningTimeline(false);
  }

  function deleteTrackFromLibrary(trackId) {
    const trackToDelete = tracksRef.current.find((track) => track.id === trackId);

    if (!trackToDelete) return;

    if (isPlaying) {
      pausePlayback();
    }

    if (trackToDelete.url && trackToDelete.url.startsWith("blob:")) {
      URL.revokeObjectURL(trackToDelete.url);
    }

    setTracks((prevTracks) => prevTracks.filter((track) => track.id !== trackId));

    setSelectedTrackIds((prevSelected) => {
      const nextSelected = prevSelected.filter((id) => id !== trackId);

      if (selectedTrackId === trackId) {
        setSelectedTrackId(nextSelected[0] || null);
      }

      return nextSelected;
    });
  }

  function deleteEffectFromLibrary(effectId) {
    stopEffectPreview();

    const manualEffect = manualEffects.find((effect) => effect.id === effectId);

    if (manualEffect?.file?.startsWith("blob:")) {
      URL.revokeObjectURL(manualEffect.file);
    }

    effectBuffersRef.current.delete(effectId);

    setManualEffects((prevEffects) =>
      prevEffects.filter((effect) => effect.id !== effectId)
    );

    setOnlineEffects((prevEffects) =>
      prevEffects.filter((effect) => effect.id !== effectId)
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">♪</div>
          <div>
            <h1>Show Audio Studio</h1>
            <p>Editor audio multitraccia per creare show</p>
          </div>
        </div>

        <div className="transport">
          <button className="transport-btn secondary" onClick={stopPlayback}>
            ⏮
          </button>

          <button
            className={`transport-btn play ${isPlaying ? "playing" : ""}`}
            onClick={togglePlayback}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>

          <button className="transport-btn secondary" onClick={stopPlayback}>
            ■
          </button>

          <div ref={timeDisplayRef} className="time-display">{formatPreciseTime(playhead)}</div>
        </div>

        <div className="mobile-edit-toolbar" aria-label="Strumenti modifica rapida">
          <button
            className="mobile-edit-btn"
            type="button"
            onClick={splitClipAtPlayhead}
            disabled={tracks.length === 0}
          >
            ✂ <span>Taglia</span>
          </button>

          <button
            className="mobile-edit-btn"
            type="button"
            onClick={duplicateSelectedTracks}
            disabled={selectedTrackIds.length === 0}
          >
            ⧉ <span>Duplica</span>
          </button>

          <button
            className="mobile-edit-btn danger"
            type="button"
            onClick={deleteSelectedTrack}
            disabled={selectedTrackIds.length === 0}
          >
            🗑 <span>Elimina</span>
          </button>
        </div>

        <div className="top-actions">
          <button
            className="ghost-btn"
            type="button"
            onClick={saveProjectInBrowser}
            disabled={isSavingProject}
          >
            {isSavingProject ? "Salvo..." : "Salva progetto"}
          </button>
          <button
            className="ghost-btn"
            type="button"
            onClick={loadProjectFromBrowser}
            disabled={isLoadingProject}
          >
            {isLoadingProject ? "Carico..." : "Carica"}
          </button>

          <select
            className="export-format-select"
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value)}
            disabled={isExporting || isSavingAudioToDevice}
            title="Formato export"
          >
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
          </select>

          <button
            className="primary-btn"
            type="button"
            onClick={() => exportProjectAudio(exportFormat)}
            disabled={tracks.length === 0 || isExporting || isSavingAudioToDevice}
          >
            {isExporting ? "Esporto..." : `Esporta ${exportFormat.toUpperCase()}`}
          </button>

          <button
            className="ghost-btn device-save-btn"
            type="button"
            onClick={() => saveProjectAudioToDevice(exportFormat)}
            disabled={tracks.length === 0 || isExporting || isSavingAudioToDevice}
          >
            {isSavingAudioToDevice ? "Salvo..." : "Salva sul dispositivo"}
          </button>
        </div>
      </header>

      <main className="editor-layout">
        <aside className="left-panel">
          <section
            className={`panel-card mobile-collapsible-card ${openMobilePanel === "audio" ? "mobile-open" : ""
              }`}
          >
            <button
              className="mobile-panel-toggle"
              type="button"
              onClick={() => toggleMobilePanel("audio")}
            >
              <span>Audio</span>
              <strong>{openMobilePanel === "audio" ? "−" : "+"}</strong>
            </button>

            <div className="mobile-panel-content">
              <div className="section-title">
                <h2>Audio</h2>
                <button className="small-btn" onClick={handleUploadClick}>
                  + Importa
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={handleInputChange}
              />

              <div
                className={`upload-box ${isDraggingOver ? "drag-over" : ""}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={handleUploadClick}
              >
                <div className="upload-icon">⬆</div>
                <strong>
                  {isImporting ? "Importazione in corso..." : "Trascina qui i file audio"}
                </strong>
                <span>MP3, WAV, M4A</span>
              </div>

              {tracks.length > 0 && (
                <div className="audio-library">
                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className={`library-item library-item-with-delete ${
                        selectedTrackIds.includes(track.id) ? "active" : ""
                      }`}
                      onClick={(event) => handleTrackClick(event, track)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleTrackClick(event, track);
                        }
                      }}
                    >
                      <div className="library-item-main">
                        <span>{track.name}</span>
                        <small>{formatTime(track.duration)}</small>
                      </div>

                      <button
                        type="button"
                        className="delete-list-btn"
                        title="Elimina brano"
                        aria-label={`Elimina ${track.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteTrackFromLibrary(track.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section
            className={`panel-card mobile-collapsible-card ${openMobilePanel === "project" ? "mobile-open" : ""
              }`}
          >
            <button
              className="mobile-panel-toggle"
              type="button"
              onClick={() => toggleMobilePanel("project")}
            >
              <span>Progetto</span>
              <strong>{openMobilePanel === "project" ? "−" : "+"}</strong>
            </button>

            <div className="mobile-panel-content">
              <div className="section-title">
                <h2>Progetto</h2>
              </div>

              <div className="project-info">
                <div>
                  <span>Tracce</span>
                  <strong>{tracks.length}</strong>
                </div>
                <div>
                  <span>Durata audio</span>
                  <strong>{formatTime(projectAudioEnd)}</strong>
                </div>
                <div>
                  <span>BPM</span>
                  <strong>Auto</strong>
                </div>
              </div>
            </div>
          </section>

          <section
            className={`panel-card mobile-collapsible-card mobile-save-panel ${openMobilePanel === "save" ? "mobile-open" : ""
              }`}
          >
            <button
              className="mobile-panel-toggle"
              type="button"
              onClick={() => toggleMobilePanel("save")}
            >
              <span>Salva progetto</span>
              <strong>{openMobilePanel === "save" ? "−" : "+"}</strong>
            </button>

            <div className="mobile-panel-content">
              <div className="section-title">
                <h2>Salvataggio</h2>
              </div>

              <div className="mobile-save-actions">
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={saveProjectInBrowser}
                  disabled={isSavingProject}
                >
                  {isSavingProject ? "Salvo..." : "Salva progetto"}
                </button>

                <button
                  className="ghost-btn"
                  type="button"
                  onClick={loadProjectFromBrowser}
                  disabled={isLoadingProject}
                >
                  {isLoadingProject ? "Carico..." : "Carica progetto"}
                </button>

                <select
                  className="export-format-select"
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value)}
                  disabled={isExporting || isSavingAudioToDevice}
                  title="Formato export"
                >
                  <option value="mp3">MP3</option>
                  <option value="wav">WAV</option>
                </select>

                <button
                  className="primary-btn"
                  type="button"
                  onClick={() => exportProjectAudio(exportFormat)}
                  disabled={tracks.length === 0 || isExporting || isSavingAudioToDevice}
                >
                  {isExporting ? "Esporto..." : `Esporta ${exportFormat.toUpperCase()}`}
                </button>

                <button
                  className="ghost-btn device-save-btn"
                  type="button"
                  onClick={() => saveProjectAudioToDevice(exportFormat)}
                  disabled={tracks.length === 0 || isExporting || isSavingAudioToDevice}
                >
                  {isSavingAudioToDevice ? "Salvo..." : "Salva sul dispositivo"}
                </button>
              </div>
            </div>
          </section>
        </aside>

        <section className="timeline-area">
          <div className="timeline-toolbar">
            <div>
              <h2>Timeline</h2>
              <p>
                Clicca nella timeline per spostare la testina. Trascina le clip
                per sincronizzare musiche, intro ed effetti.
              </p>
            </div>

            <div className="timeline-tools">
              <button className="tool-btn" type="button" onClick={zoomOutTimeline}>− Zoom</button>
              <button className="tool-btn" type="button" onClick={zoomInTimeline}>+ Zoom</button>
              <button className="tool-btn">Snap: ON</button>
              <span className="zoom-indicator">{pixelsPerSecond}px/s</span>
              <button
                className="tool-btn cut-btn"
                onClick={splitClipAtPlayhead}
                type="button"
                title="Taglia la clip selezionata nel punto della testina"
              >
                ✂ Taglia
              </button>
              <button
                className={`tool-btn ${followPlayhead ? "active" : ""}`}
                onClick={() => setFollowPlayhead((prev) => !prev)}
                type="button"
              >
                {followPlayhead ? "Segui testina: ON" : "Segui testina: OFF"}
              </button>
            </div>
          </div>

          <div
            ref={timelineRef}
            className={`timeline ${isDraggingClip ? "dragging-clip" : ""} ${isTrimmingClip ? "trimming-clip" : ""
              } ${isPanningTimeline ? "panning-timeline" : ""}`}
            onDrop={handleTimelineDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onPointerDown={handleTimelinePointerDown}
            style={{ "--pps": `${pixelsPerSecond}px` }}
          >

            <div
              className="time-ruler"
              style={{ width: `${timelineContentWidth}px` }}
            >
              <div className="track-label-placeholder"></div>

              <div className="ruler-scroll">
                {seconds.map((sec) => (
                  <div key={sec} className="ruler-mark" style={{ width: `${pixelsPerSecond}px` }}>
                    <span>{sec}s</span>
                  </div>
                ))}
              </div>

              <div
                ref={rulerPlayheadRef}
                className="ruler-playhead"
                style={{
                  left: `${160 + playhead * pixelsPerSecond}px`,
                }}
              />
            </div>

            <div
              className="tracks-wrapper"
              style={{ width: `${timelineContentWidth}px` }}
            >
              <div
                ref={timelinePlayheadRef}
                className="timeline-playhead"
                style={{
                  left: `${160 + playhead * pixelsPerSecond}px`,
                }}
              >
                <span />
              </div>

              {tracks.length === 0 && (
                <div className="empty-editor-state">
                  <div>
                    <h3>Nessuna traccia ancora</h3>
                    <p>
                      Importa una canzone, un effetto o una base audio per
                      iniziare a costruire lo show.
                    </p>
                    <button className="primary-btn" onClick={handleUploadClick}>
                      Importa primo audio
                    </button>
                  </div>
                </div>
              )}

              {tracks.map((track) => (
                <div
                  key={track.id}
                  className={`track-row ${selectedTrackIds.includes(track.id) ? "selected" : ""
                    }`}
                  onClick={(event) => handleTrackClick(event, track)}
                >
                  <div className="track-label">
                    <strong>
                      {track.type === "effect" ? "FX · " : ""}
                      {track.name}
                    </strong>
                    <span>
                      Start {formatTime(track.start)} · Vol {track.volume}%
                    </span>
                    <div className="track-actions">
                      <button
                        type="button"
                        className={track.muted ? "active" : ""}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleTrackFlag(track.id, "muted");
                        }}
                        title="Mute"
                      >
                        M
                      </button>
                      <button
                        type="button"
                        className={track.solo ? "active" : ""}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleTrackFlag(track.id, "solo");
                        }}
                        title="Solo"
                      >
                        S
                      </button>
                    </div>
                  </div>

                  <div className="track-lane" style={{ backgroundSize: `${pixelsPerSecond}px 100%` }}>
                    <div
                      data-track-id={track.id}
                      className={`audio-clip ${track.color} ${selectedTrackIds.includes(track.id) ? "selected-clip" : ""}`}
                      style={{
                        left: `${track.start * pixelsPerSecond}px`,
                        width: `${Math.max(
                          track.duration * pixelsPerSecond,
                          120
                        )}px`,
                      }}
                      onPointerDown={(event) =>
                        handleClipPointerDown(event, track)
                      }
                    >
                      <div
                        className="trim-handle trim-handle-left"
                        onPointerDown={(event) =>
                          handleTrimPointerDown(event, track, "left")
                        }
                        title="Trascina per tagliare l'inizio"
                      />

                      <div
                        className="trim-handle trim-handle-right"
                        onPointerDown={(event) =>
                          handleTrimPointerDown(event, track, "right")
                        }
                        title="Trascina per tagliare la fine"
                      />

                      <div className="clip-header">
                        <span>
                          {track.type === "effect" ? "FX · " : ""}
                          {track.name}
                        </span>
                        <span>{formatTime(track.duration)}</span>
                      </div>

                      <div className="clip-fade-layer">
                        {track.fadeIn > 0 && (
                          <div
                            className="fade-visual fade-visual-in"
                            style={{
                              width: `${Math.min(
                                track.fadeIn * pixelsPerSecond,
                                track.duration * pixelsPerSecond * 0.5
                              )}px`,
                            }}
                          >
                            <span>{track.fadeIn}s</span>
                          </div>
                        )}

                        {track.fadeOut > 0 && (
                          <div
                            className="fade-visual fade-visual-out"
                            style={{
                              width: `${Math.min(
                                track.fadeOut * pixelsPerSecond,
                                track.duration * pixelsPerSecond * 0.5
                              )}px`,
                            }}
                          >
                            <span>{track.fadeOut}s</span>
                          </div>
                        )}
                      </div>

                      <div className="real-waveform">
                        <svg
                          viewBox={`0 0 ${track.waveformPeaks?.length || 1} 100`}
                          preserveAspectRatio="none"
                        >
                          {(track.waveformPeaks || []).map((peak, index) => {
                            const height = Math.max(6, peak * 86);
                            const y = (100 - height) / 2;

                            return (
                              <line
                                key={index}
                                x1={index}
                                x2={index}
                                y1={y}
                                y2={y + height}
                                vectorEffect="non-scaling-stroke"
                              />
                            );
                          })}
                        </svg>
                      </div>

                      <div className="fade-handles">
                        <span>Fade In {track.fadeIn}s</span>
                        <span>Fade Out {track.fadeOut}s</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {tracks.length > 0 && (
                <div className="empty-track">
                  <div className="track-label muted">Nuova traccia</div>
                  <div className="track-lane dashed">
                    Trascina qui audio o effetti
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="right-panel">
          <section
            className={`panel-card effects-card mobile-collapsible-card ${openMobilePanel === "effects" ? "mobile-open" : ""
              }`}
          >
            <button
              className="mobile-panel-toggle"
              type="button"
              onClick={() => toggleMobilePanel("effects")}
            >
              <span>Effetti</span>
              <strong>{openMobilePanel === "effects" ? "−" : "+"}</strong>
            </button>

            <div className="mobile-panel-content">
              <div className="section-title">
                <h2>Effetti</h2>

                <button
                  className="small-btn"
                  type="button"
                  onClick={() => effectFileInputRef.current?.click()}
                >
                  + Importa
                </button>
              </div>

              <input
                ref={effectFileInputRef}
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={handleEffectFileInputChange}
              />

              <div className="effects-search">
                <input
                  value={effectSearch}
                  placeholder="Cerca online: whoosh, impact, applause..."
                  onChange={(event) => setEffectSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      searchOnlineEffects();
                    }
                  }}
                />

                <button
                  type="button"
                  className="search-effect-btn"
                  onClick={() => searchOnlineEffects()}
                  disabled={isSearchingEffects}
                >
                  {isSearchingEffects ? "Cerco..." : "Cerca"}
                </button>
              </div>

              {effectsError && <p className="effects-error">{effectsError}</p>}

              {availableEffects.length === 0 ? (
                <div className="empty-effects-state">
                  <strong>Cerca o importa effetti</strong>
                  <span>
                    Puoi cercare online oppure caricare manualmente file MP3, WAV o M4A.
                  </span>
                </div>
              ) : (
                <div className="effects-list">
                  {availableEffects.map((effect) => (
                    <div
                      key={effect.id}
                      className="effect-item"
                      draggable
                      onDragStart={(event) => handleEffectDragStart(event, effect)}
                      onClick={(event) => {
                        if (event.target.closest("button")) return;
                        if (window.matchMedia("(max-width: 800px), (pointer: coarse)").matches) {
                          addEffectFromPanel(effect);
                        }
                      }}
                      title="Trascina nella timeline o tocca per aggiungerlo alla testina"
                    >
                      <div className="effect-main">
                        <strong>{effect.name}</strong>

                        <span>
                          {effect.category}
                          {effect.creator ? ` · ${effect.creator}` : ""}
                        </span>

                        {effect.license && (
                          <small className="effect-license">{effect.license}</small>
                        )}
                      </div>

                      <div className="effect-actions">
                        <button
                          type="button"
                          className={previewingEffectId === effect.id ? "previewing" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            previewEffect(effect);
                          }}
                          title={previewingEffectId === effect.id ? "Ferma anteprima" : "Ascolta anteprima"}
                        >
                          {previewingEffectId === effect.id ? "■" : "▶"}
                        </button>

                        <button
                          type="button"
                          className="add-effect-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            addEffectFromPanel(effect);
                          }}
                          title="Aggiungi alla testina"
                        >
                          +
                        </button>

                        <button
                          type="button"
                          className="delete-list-btn"
                          title="Elimina effetto"
                          aria-label={`Elimina ${effect.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteEffectFromLibrary(effect.id);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel-card inspector-card">
            <div className="section-title">
              <h2>Modifica</h2>
            </div>

            {selectedTrack ? (
              <div className="inspector-content">
                <div className="selected-info">
                  <strong>{selectedTrack.name}</strong>
                  <span>
                    Start {formatTime(selectedTrack.start)} · Durata{" "}
                    {formatTime(selectedTrack.duration)}
                  </span>
                  <small>
                    Sorgente {formatTime(selectedTrack.sourceStart || 0)} → {formatTime((selectedTrack.sourceStart || 0) + selectedTrack.duration)}
                  </small>
                </div>

                <label>
                  Volume: {selectedTrack.volume}%
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={selectedTrack.volume}
                    onChange={(event) =>
                      updateSelectedTrack("volume", Number(event.target.value))
                    }
                  />
                </label>

                <label>
                  Fade In: {selectedTrack.fadeIn}s
                  <input
                    type="range"
                    min="0"
                    max="10"
                    step="0.5"
                    value={selectedTrack.fadeIn}
                    onChange={(event) =>
                      updateSelectedTrack("fadeIn", Number(event.target.value))
                    }
                  />
                </label>

                <label>
                  Fade Out: {selectedTrack.fadeOut}s
                  <input
                    type="range"
                    min="0"
                    max="10"
                    step="0.5"
                    value={selectedTrack.fadeOut}
                    onChange={(event) =>
                      updateSelectedTrack("fadeOut", Number(event.target.value))
                    }
                  />
                </label>

                <button className="ghost-btn" type="button" onClick={splitClipAtPlayhead}>
                  ✂ Taglia alla testina
                </button>

                <button className="danger-btn" onClick={deleteSelectedTrack}>
                  Elimina traccia
                </button>
              </div>
            ) : (
              <p className="empty-inspector">
                Seleziona una traccia per modificarla.
              </p>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;