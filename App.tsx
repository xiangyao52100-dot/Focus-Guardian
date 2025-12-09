import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { WebcamMonitor, WebcamMonitorHandle } from './components/WebcamMonitor';
import { StatusOverlay } from './components/StatusOverlay';
import { AnalysisResult, StudyStatus, StudySession } from './types';

// --- Audio Generator Logic ---
// 使用 Web Audio API 生成白噪音/布朗噪音/粉红噪音，无需加载外部文件，永不失效
class NoiseGenerator {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private isPlaying: boolean = false;
  private currentType: 'brown' | 'white' | 'pink' = 'brown';

  constructor() {}

  play(type: 'brown' | 'white' | 'pink', volume: number) {
    // If playing same type, just ensure volume is right (handled by setVolume)
    if (this.isPlaying && this.currentType === type) {
       return; 
    }
    
    this.stop(); // Stop existing if any

    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!this.ctx) {
      this.ctx = new AudioContextClass();
    }
    
    if (this.ctx?.state === 'suspended') {
       this.ctx.resume();
    }

    this.currentType = type;
    const bufferSize = this.ctx!.sampleRate * 2; // 2 seconds loop is enough for noise
    const buffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'white') {
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    } else if (type === 'pink') {
      // Pink noise (Rain-like)
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        data[i] *= 0.11; // Compensate for gain
        b6 = white * 0.115926;
      }
    } else {
      // Brown noise (Red noise) - smoother, deeper
      let lastOut = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + (0.02 * white)) / 1.02;
        data[i] = lastOut * 3.5; 
        if (!isFinite(data[i])) data[i] = 0;
      }
    }

    this.source = this.ctx!.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.gainNode = this.ctx!.createGain();
    this.gainNode.gain.value = volume;
    
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.ctx!.destination);
    this.source.start();
    this.isPlaying = true;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
        this.source.disconnect();
      } catch (e) {
        // ignore if already stopped
      }
      this.source = null;
    }
    this.isPlaying = false;
  }

  setVolume(volume: number) {
    if (this.gainNode && this.ctx) {
       // Smooth transition
       try {
         this.gainNode.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
       } catch (e) {
         this.gainNode.gain.value = volume;
       }
    }
  }
}

interface Track {
  name: string;
  type: 'generator' | 'audio';
  url?: string;
  noiseType?: 'brown' | 'white' | 'pink';
}

const PLAYLIST: Track[] = [
  { name: "Brown Noise (深度专注)", type: 'generator', noiseType: 'brown' },
  { name: "Pink Noise (舒缓雨声)", type: 'generator', noiseType: 'pink' },
  { name: "White Noise (隔绝噪音)", type: 'generator', noiseType: 'white' },
  // 💡 如果您想播放本地音乐，请取消下方注释，并确保在 public/music/ 文件夹中有对应的 MP3 文件
  // { name: "Local: Rain (需上传)", type: 'audio', url: '/music/rain.mp3' },
  // { name: "Local: Lofi (需上传)", type: 'audio', url: '/music/lofi.mp3' }
];

function App() {
  const [isMonitoring, setIsMonitoring] = useState(false);
  // Use Ref to track monitoring status for callbacks to avoid race conditions and dependency cycles
  const isMonitoringRef = useRef(false);

  const [currentResult, setCurrentResult] = useState<AnalysisResult>({
    status: StudyStatus.IDLE,
    reason: "",
    confidence: 0
  });

  // PiP State
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  // Session State
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  
  // Sensitivity / Tolerance Level (1 = Strict/Instant, 5 = Lenient)
  const [sensitivity, setSensitivity] = useState(2);

  // Audio State
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.5);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);
  
  const audioRef = useRef<HTMLAudioElement>(null);
  const noiseGenRef = useRef<NoiseGenerator>(new NoiseGenerator());

  // Stats tracking for current session
  const statsRef = useRef({
    studying: 0,
    distracted: 0,
    absent: 0,
    total: 0
  });

  // Track consecutive distractions to prevent flickering warnings
  const consecutiveBadChecksRef = useRef(0);

  // Webcam Monitor Ref
  const monitorRef = useRef<WebcamMonitorHandle>(null);

  // Timer effect
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isMonitoring && startTime) {
      interval = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isMonitoring, startTime]);

  // --- Unified Audio Logic ---
  
  // 1. Calculate Target Volume (Ducking Logic)
  const getTargetVolume = useCallback(() => {
    let target = musicVolume;
    if (currentResult.status === StudyStatus.DISTRACTED || currentResult.status === StudyStatus.ABSENT) {
      target = musicVolume * 0.2; // Duck volume to 20%
    }
    return target;
  }, [currentResult.status, musicVolume]);

  // 2. Playback Control Effect
  useEffect(() => {
    const track = PLAYLIST[currentTrackIndex];
    const shouldPlay = isMonitoring && isMusicPlaying;
    const targetVolume = getTargetVolume();

    // Reset error when switching tracks
    setAudioError(null);

    if (track.type === 'generator') {
      // Pause HTML Audio
      if (audioRef.current) {
        audioRef.current.pause();
      }

      if (shouldPlay) {
        noiseGenRef.current.play(track.noiseType!, targetVolume);
        noiseGenRef.current.setVolume(targetVolume); // Ensure volume update
      } else {
        noiseGenRef.current.stop();
      }
    } else {
      // Stop Generator
      noiseGenRef.current.stop();

      if (audioRef.current) {
        // Update volume first
        audioRef.current.volume = targetVolume;
        
        if (shouldPlay) {
          const playPromise = audioRef.current.play();
          if (playPromise !== undefined) {
            playPromise.catch(e => {
              console.error("Audio play failed:", e);
              setAudioError("无法播放音频文件。请确认文件是否存在。");
            });
          }
        } else {
          audioRef.current.pause();
        }
      }
    }
  }, [isMonitoring, isMusicPlaying, currentTrackIndex, getTargetVolume]);

  // 3. Volume Only Update (For smooth ducking without restarting)
  useEffect(() => {
     const targetVolume = getTargetVolume();
     const track = PLAYLIST[currentTrackIndex];

     if (track.type === 'generator') {
        noiseGenRef.current.setVolume(targetVolume);
     } else if (audioRef.current) {
        audioRef.current.volume = targetVolume;
     }
  }, [getTargetVolume, currentTrackIndex]);

  const handleStatusChange = useCallback((result: AnalysisResult) => {
    // Check ref to ensure we don't process results after stopping
    if (!isMonitoringRef.current) return;

    // 1. Stats tracking (Always record raw data for accuracy)
    statsRef.current.total += 1;
    if (result.status === StudyStatus.STUDYING) statsRef.current.studying += 1;
    else if (result.status === StudyStatus.DISTRACTED) statsRef.current.distracted += 1;
    else if (result.status === StudyStatus.ABSENT) statsRef.current.absent += 1;

    // 2. UI Update Logic (Debounced based on Sensitivity)
    // Only trigger warning UI if detected as DISTRACTED/ABSENT for 'sensitivity' consecutive checks
    if (result.status === StudyStatus.DISTRACTED || result.status === StudyStatus.ABSENT) {
      consecutiveBadChecksRef.current += 1;
      
      if (consecutiveBadChecksRef.current >= sensitivity) {
        setCurrentResult(result);
      } else {
        // First bad checks: ignore update to prevent flickering
        console.log(`Potential distraction detected (${consecutiveBadChecksRef.current}/${sensitivity}), waiting for confirmation...`);
      }
    } else {
      // If STUDYING or IDLE/Error, update immediately and reset counter
      consecutiveBadChecksRef.current = 0;
      setCurrentResult(result);
    }
  }, [sensitivity]); // Stable dependency, won't change on every render

  const handleManualRefresh = () => {
    if (monitorRef.current) {
      // Trigger user feedback or log
      console.log("Manual refresh triggered");
      monitorRef.current.triggerAnalysis();
    }
  };

  const nextTrack = () => {
    setCurrentTrackIndex((prev) => (prev + 1) % PLAYLIST.length);
  };

  const prevTrack = () => {
    setCurrentTrackIndex((prev) => (prev - 1 + PLAYLIST.length) % PLAYLIST.length);
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const toggleMonitoring = () => {
    if (isMonitoring) {
      // STOP Session
      isMonitoringRef.current = false;
      const endTime = Date.now();
      const duration = startTime ? Math.floor((endTime - startTime) / 1000) : 0;
      
      // Calculate Score
      const totalChecks = statsRef.current.total;
      const focusScore = totalChecks > 0 
        ? Math.round((statsRef.current.studying / totalChecks) * 100) 
        : 0;

      const newSession: StudySession = {
        id: Date.now().toString(),
        startTime: startTime || Date.now(),
        endTime,
        duration,
        focusScore,
        statusCounts: { ...statsRef.current }
      };

      setSessions(prev => [newSession, ...prev]);
      
      // Reset
      setIsMonitoring(false);
      setCurrentResult({ status: StudyStatus.IDLE, reason: "", confidence: 0 });
      setStartTime(null);
      setElapsedTime(0);
      consecutiveBadChecksRef.current = 0;
      // Stop noise generator explicitly when monitoring stops
      noiseGenRef.current.stop();
    } else {
      // START Session
      isMonitoringRef.current = true;
      setIsMonitoring(true);
      setStartTime(Date.now());
      setElapsedTime(0);
      // Reset stats
      statsRef.current = { studying: 0, distracted: 0, absent: 0, total: 0 };
      consecutiveBadChecksRef.current = 0;
    }
  };

  const togglePiP = async () => {
    // If PiP is open, close it
    if (pipWindow) {
      pipWindow.close();
      setPipWindow(null);
      return;
    }

    // Check API support
    if (!('documentPictureInPicture' in window)) {
      alert("您的浏览器不支持悬浮窗功能 (Document Picture-in-Picture API)。建议使用最新版 Chrome 或 Edge。");
      return;
    }

    try {
      // Request a PiP window
      const pip = await (window as any).documentPictureInPicture.requestWindow({
        width: 340,
        height: 480,
      });

      // 1. Copy Tailwind CDN
      const tailwindScript = pip.document.createElement('script');
      tailwindScript.src = "https://cdn.tailwindcss.com";
      pip.document.head.appendChild(tailwindScript);

      // 2. Inject Tailwind Config (Critical for custom animations like 'wiggle' and 'fade-in-up')
      const configScript = pip.document.createElement('script');
      configScript.textContent = `
        tailwind.config = {
          theme: {
            extend: {
              animation: {
                'fade-in-up': 'fadeInUp 0.5s ease-out',
                'wiggle': 'wiggle 0.3s ease-in-out infinite',
              },
              keyframes: {
                fadeInUp: {
                  '0%': { opacity: '0', transform: 'translateY(20px)' },
                  '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                wiggle: {
                  '0%, 100%': { transform: 'rotate(-3deg)' },
                  '50%': { transform: 'rotate(3deg)' },
                }
              }
            }
          }
        }
      `;
      pip.document.head.appendChild(configScript);

      // 3. Copy any other stylesheets (e.g., from style tags)
      Array.from(document.styleSheets).forEach((styleSheet) => {
        try {
          if (styleSheet.cssRules) {
            const newStyleEl = pip.document.createElement('style');
            Array.from(styleSheet.cssRules).forEach((rule) => {
              newStyleEl.appendChild(document.createTextNode(rule.cssText));
            });
            pip.document.head.appendChild(newStyleEl);
          }
        } catch (e) {
          console.warn("Skipping CORS stylesheet:", e);
        }
      });

      // 4. Set Body Class for dark mode bg
      pip.document.body.className = "bg-slate-900 text-white overflow-hidden";

      // 5. Cleanup on close
      pip.addEventListener('pagehide', () => {
        setPipWindow(null);
      });

      setPipWindow(pip);
    } catch (err: any) {
      console.error("Failed to open PiP window:", err);
      let msg = "无法打开悬浮窗。\n";
      if (err.name === "NotAllowedError") {
        msg += "原因：浏览器权限被拒绝。请确保您是在点击按钮后立即触发此操作。\n";
      } else if (err.name === "SecurityError") {
        msg += "原因：当前安全环境（如 iframe）禁用了悬浮窗功能。\n";
      } else {
        msg += `错误信息: ${err.message || err}\n`;
      }
      alert(msg);
    }
  };

  // --- Render Content Logic ---

  // The Monitoring Component (Video + Overlay)
  const renderMonitorContent = (isMiniMode: boolean) => (
    <div className={`relative flex flex-col ${isMiniMode ? 'h-full' : ''}`}>
      <WebcamMonitor 
        ref={monitorRef}
        isMonitoring={isMonitoring} 
        onStatusChange={handleStatusChange} 
      />
      
      {/* Time Overlay */}
      {isMonitoring && (
        <div className={`absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1 rounded-lg border border-slate-600 flex items-center z-10 ${isMiniMode ? 'scale-75 origin-top-left' : ''}`}>
          <div className={`w-2 h-2 rounded-full mr-2 ${elapsedTime % 2 === 0 ? 'bg-red-500' : 'bg-transparent'}`}></div>
          <span className="text-lg font-mono font-bold text-white">{formatTime(elapsedTime)}</span>
        </div>
      )}

      {/* Mini Mode Status Footer (Only shown in PiP) */}
      {isMiniMode && isMonitoring && (
        <div className={`flex-1 flex flex-col items-center justify-center p-4 text-center transition-colors duration-500 relative ${
           currentResult.status === StudyStatus.STUDYING ? 'bg-green-900/30' :
           currentResult.status === StudyStatus.DISTRACTED ? 'bg-red-900/30' : 'bg-slate-900'
        }`}>
           {/* Manual Refresh Button in PiP */}
           <button 
             onClick={handleManualRefresh}
             className="absolute top-2 right-2 text-slate-400 hover:text-white p-2 rounded-full hover:bg-white/10 transition-colors"
             title="立即刷新检测"
           >
             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
           </button>

           <div className={`text-2xl mb-2 ${currentResult.status === StudyStatus.DISTRACTED ? 'animate-bounce' : ''}`}>
             {currentResult.status === StudyStatus.STUDYING ? '🌟' : 
              currentResult.status === StudyStatus.DISTRACTED ? '🚨' : '👀'}
           </div>
           <p className={`font-bold text-lg ${
             currentResult.status === StudyStatus.STUDYING ? 'text-green-400' :
             currentResult.status === StudyStatus.DISTRACTED ? 'text-red-400' : 'text-slate-400'
           }`}>
             {currentResult.status === StudyStatus.IDLE ? '分析中...' : 
              currentResult.status === StudyStatus.STUDYING ? '专注中' : 
              currentResult.status === StudyStatus.DISTRACTED ? '已分心!' : '人不在'}
           </p>
           {currentResult.reason && (
             <p className="text-xs text-slate-400 mt-1 line-clamp-2 leading-tight">
               {currentResult.reason}
             </p>
           )}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans selection:bg-purple-500 selection:text-white relative overflow-x-hidden">
      
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 fixed">
        <div className="absolute -top-20 -left-20 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl"></div>
        <div className="absolute top-1/2 right-0 w-80 h-80 bg-blue-600/20 rounded-full blur-3xl"></div>
      </div>

      {/* HTML Audio for Local Files - Only render if needed to avoid 'No supported sources' error */}
      {PLAYLIST[currentTrackIndex].type === 'audio' && (
        <audio 
          ref={audioRef} 
          src={PLAYLIST[currentTrackIndex].url} 
          loop 
          onError={(e) => {
              console.error("Audio error:", e);
              if (isMonitoring && isMusicPlaying) {
                  setAudioError("无法播放音频文件。请确认文件是否存在于 public/music/ 文件夹中。");
              }
          }}
        />
      )}

      <main className="container mx-auto px-4 py-8 flex flex-col items-center min-h-screen">
        
        <header className="mb-8 text-center">
          <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 mb-2">
            Focus Guardian
          </h1>
          <p className="text-slate-400 text-lg">AI 驱动的学习监督助手</p>
        </header>

        <div className="w-full max-w-2xl bg-slate-800/50 backdrop-blur-lg border border-slate-700 rounded-3xl p-6 shadow-2xl mb-8">
          
          <div className="mb-6 relative min-h-[300px] flex items-center justify-center bg-black/20 rounded-2xl overflow-hidden">
            {/* 
              MAIN VIEW RENDER LOGIC:
              If PiP window is open, we show a placeholder here.
              If PiP window is closed, we show the actual monitor here.
            */}
            {pipWindow ? (
              <div className="flex flex-col items-center justify-center text-slate-500 p-8 text-center h-64 w-full">
                <div className="w-16 h-16 mb-4 rounded-full bg-slate-700 flex items-center justify-center animate-pulse">
                  <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </div>
                <h3 className="text-xl font-bold text-white mb-2">正在悬浮窗模式运行</h3>
                <p className="max-w-xs text-sm">监控画面已移动到独立悬浮窗口。点击下方“关闭悬浮窗”按钮返回。</p>
                {/* Manual Refresh in Placeholder if needed, but not common */}
              </div>
            ) : (
              renderMonitorContent(false)
            )}
          </div>

          <div className="flex flex-col items-center gap-4">
            
            {/* Main Status Text (Only visible when not in PiP mode) */}
            {!pipWindow && (
              <div className={`px-4 sm:px-6 py-3 rounded-full border flex items-center gap-3 ${
                isMonitoring 
                  ? currentResult.status === StudyStatus.STUDYING 
                    ? 'bg-green-500/20 border-green-500 text-green-300' 
                    : currentResult.status === StudyStatus.IDLE
                      ? 'bg-slate-700/50 border-slate-600 text-slate-300'
                      : 'bg-red-500/20 border-red-500 text-red-300'
                  : 'bg-slate-700/50 border-slate-600 text-slate-400'
              } transition-all duration-300 max-w-md w-full justify-between`}>
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className={`w-3 h-3 rounded-full flex-shrink-0 ${isMonitoring ? 'animate-pulse' : ''} ${
                    currentResult.status === StudyStatus.STUDYING ? 'bg-green-500' :
                    currentResult.status === StudyStatus.DISTRACTED ? 'bg-red-500' :
                    'bg-slate-500'
                  }`}></div>
                  <div className="flex flex-col items-start overflow-hidden">
                    <span className="font-mono font-bold tracking-wider text-sm leading-tight">
                      {isMonitoring ? (currentResult.status === 'IDLE' ? 'INITIALIZING...' : currentResult.status) : "READY"}
                    </span>
                    {isMonitoring && currentResult.reason && (
                      <span className="text-xs opacity-80 truncate w-full max-w-[150px] sm:max-w-[200px]" title={currentResult.reason}>
                        {currentResult.reason}
                      </span>
                    )}
                  </div>
                </div>
                
                {/* Manual Refresh Button - Main View */}
                {isMonitoring && (
                  <button 
                    onClick={handleManualRefresh}
                    className="flex-shrink-0 text-slate-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors"
                    title="立即刷新检测 (R)"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-4 w-full">
              <button
                onClick={toggleMonitoring}
                className={`group relative inline-flex items-center justify-center px-8 py-4 text-lg font-bold text-white transition-all duration-200 rounded-full focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                  isMonitoring 
                    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-600' 
                    : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-600'
                }`}
              >
                <span className="absolute inset-0 w-full h-full mt-1 ml-1 transition-all duration-200 ease-out bg-black rounded-full group-hover:mt-0 group-hover:ml-0 opacity-30"></span>
                <span className="relative flex items-center gap-2">
                  {isMonitoring ? (
                    <>
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
                      结束本次学习
                    </>
                  ) : (
                    <>
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      开始专注模式
                    </>
                  )}
                </span>
              </button>

              <button
                onClick={togglePiP}
                className="inline-flex items-center justify-center px-6 py-4 text-base font-bold text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors rounded-full focus:outline-none focus:ring-2 focus:ring-slate-500"
                title={pipWindow ? "关闭悬浮窗" : "开启悬浮小窗模式"}
              >
                 {pipWindow ? (
                   <>
                     <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                     关闭悬浮窗
                   </>
                 ) : (
                   <>
                     <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                     悬浮窗模式
                   </>
                 )}
              </button>
            </div>

            {/* Sensitivity Slider */}
            {!isMonitoring && (
              <div className="w-full max-w-md mt-6 pt-6 border-t border-slate-700/50">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-slate-300 text-sm font-bold flex items-center gap-2">
                    <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"></path></svg>
                    警告触发灵敏度
                  </span>
                  <span className={`text-xs font-bold px-2 py-1 rounded ${
                    sensitivity <= 2 ? 'bg-red-500/20 text-red-300' : 'bg-green-500/20 text-green-300'
                  }`}>
                    {sensitivity === 1 ? '非常严厉' : sensitivity <= 2 ? '严格' : sensitivity === 3 ? '标准' : '宽松'}
                  </span>
                </div>
                
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={sensitivity}
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400 transition-all"
                />
                
                <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
                  <span>立即警告 (1)</span>
                  <span className="text-slate-400">连续检测 {sensitivity} 次后触发</span>
                  <span>宽松容忍 (5)</span>
                </div>
              </div>
            )}

            {/* Background Music Controls */}
            <div className="w-full max-w-md mt-6 pt-6 border-t border-slate-700/50">
              <div className="flex flex-col gap-4">
                 <div className="flex justify-between items-center">
                    <span className="text-slate-300 text-sm font-bold flex items-center gap-2 truncate max-w-[180px]">
                        <svg className="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" /></svg>
                        {PLAYLIST[currentTrackIndex].name}
                    </span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={prevTrack} className="p-1 hover:text-white text-slate-400 transition-colors">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M8.445 14.832A1 1 0 0010 14v-2.798l5.445 3.63A1 1 0 0017 14V6a1 1 0 00-1.555-.832L10 8.798V6a1 1 0 00-1.555-.832l-6 4a1 1 0 000 1.664l6 4z"/></svg>
                      </button>
                      <button 
                        onClick={() => setIsMusicPlaying(!isMusicPlaying)}
                        className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${
                          isMusicPlaying ? 'bg-purple-500 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                        }`}
                      >
                        {isMusicPlaying ? '暂停' : '播放'}
                      </button>
                      <button onClick={nextTrack} className="p-1 hover:text-white text-slate-400 transition-colors">
                         <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M4.555 14.832l-3.11-2.074A1 1 0 011 11.926V6a1 1 0 011.555-.832L6 7.202V6a1 1 0 011.555-.832l6 4a1 1 0 010 1.664l-6 4a1 1 0 01-1.555-.832L6 12.798v2.034a1 1 0 01-.445.832z"/></svg>
                      </button>
                    </div>
                 </div>

                 <div className="flex items-center gap-4">
                    <span className="text-xs text-slate-500">Vol</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={musicVolume}
                      onChange={(e) => setMusicVolume(Number(e.target.value))}
                      disabled={!isMusicPlaying}
                      className={`w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500 hover:accent-purple-400 transition-all ${!isMusicPlaying ? 'opacity-50' : ''}`}
                    />
                    <span className="text-xs text-slate-400 w-8 text-right">{Math.round(musicVolume * 100)}%</span>
                 </div>
                 
                 {audioError ? (
                   <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-xs p-2 rounded mt-2">
                     {audioError}
                   </div>
                 ) : (
                   <div className="text-xs text-slate-500 leading-relaxed">
                      <span className="text-purple-400 mr-1">💡 智能联动:</span> 
                      音乐只在开启监控时播放。当你分心时，音量会自动降低作为提醒。
                   </div>
                 )}
              </div>
            </div>

          </div>
        </div>

        {/* History Section */}
        {sessions.length > 0 && (
          <div className="w-full max-w-2xl bg-slate-800/30 backdrop-blur-md border border-slate-700/50 rounded-3xl p-6">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              学习历史记录
            </h2>
            <div className="space-y-3">
              {sessions.map((session) => (
                <div key={session.id} className="bg-slate-900/50 rounded-xl p-4 border border-slate-700 flex items-center justify-between transition-colors hover:border-slate-600">
                  <div>
                    <div className="text-slate-400 text-sm mb-1">
                      {new Date(session.startTime).toLocaleString('zh-CN', { 
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                      })}
                    </div>
                    <div className="font-mono text-xl text-white font-medium">
                      {formatTime(session.duration)}
                    </div>
                  </div>
                  
                  <div className="flex flex-col items-end">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">专注度</div>
                    <div className={`text-2xl font-bold ${
                      session.focusScore >= 80 ? 'text-green-400' :
                      session.focusScore >= 50 ? 'text-yellow-400' :
                      'text-red-400'
                    }`}>
                      {session.focusScore}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      {/* Full Screen Overlays for Rewards/Punishments (Only on Main Window) */}
      {!pipWindow && <StatusOverlay result={currentResult} />}

      {/* PiP Portal: Render content into the floating window if it exists */}
      {pipWindow && createPortal(
        renderMonitorContent(true),
        pipWindow.document.body
      )}
      
    </div>
  );
}

export default App;