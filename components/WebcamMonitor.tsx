import React, { useRef, useEffect, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { StudyStatus, AnalysisResult } from '../types';
import { analyzeFrame } from '../services/geminiService';

export interface WebcamMonitorHandle {
  triggerAnalysis: () => void;
}

interface WebcamMonitorProps {
  isMonitoring: boolean;
  onStatusChange: (result: AnalysisResult) => void;
}

const CAPTURE_INTERVAL_MS = 4000; // Check every 4 seconds

export const WebcamMonitor = forwardRef<WebcamMonitorHandle, WebcamMonitorProps>(({ isMonitoring, onStatusChange }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false); // Ref to track processing status without triggering re-renders/dependency changes

  // Initialize Webcam
  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480, facingMode: "user" } 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setStreamError(null);
      } catch (err) {
        console.error("Error accessing webcam:", err);
        setStreamError("无法访问摄像头。请允许摄像头权限以开始监控。");
      }
    };

    if (isMonitoring) {
      startCamera();
    } else {
      // Stop stream if not monitoring
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
    }

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [isMonitoring]);

  const captureAndAnalyze = useCallback(async () => {
    // Check ref instead of state to avoid changing dependency identity
    if (!videoRef.current || !canvasRef.current || isProcessingRef.current) return;

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Ensure video is actually ready
      if (video.readyState < 2 || video.videoWidth === 0) return;

      // Update both ref (for logic) and state (for UI)
      isProcessingRef.current = true;
      setIsProcessing(true);
      
      const context = canvas.getContext('2d');

      if (context) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const base64Image = canvas.toDataURL('image/jpeg', 0.7); // 0.7 quality for speed
        
        const result = await analyzeFrame(base64Image);
        onStatusChange(result);
      }
    } catch (error) {
      console.error("Capture error:", error);
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  }, [onStatusChange]); // Removed isProcessing from dependencies to keep function stable

  useImperativeHandle(ref, () => ({
    triggerAnalysis: () => {
      if (isMonitoring && !isProcessingRef.current) {
        console.log("Triggering manual analysis...");
        captureAndAnalyze();
      }
    }
  }));

  // Interval for analysis
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;

    if (isMonitoring && !streamError) {
      // Try to capture immediately, then set interval
      const timeoutId = setTimeout(captureAndAnalyze, 1000); // Small delay to let camera warm up
      intervalId = setInterval(captureAndAnalyze, CAPTURE_INTERVAL_MS);

      return () => {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
      };
    }
  }, [isMonitoring, streamError, captureAndAnalyze]);

  return (
    <div className="relative w-full max-w-md mx-auto overflow-hidden rounded-2xl shadow-xl bg-gray-900 aspect-video">
      {streamError ? (
        <div className="flex items-center justify-center h-full text-red-400 p-4 text-center">
          {streamError}
        </div>
      ) : (
        <>
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            muted 
            className={`w-full h-full object-cover transform scale-x-[-1] transition-opacity duration-500 ${isMonitoring ? 'opacity-100' : 'opacity-20'}`}
            onLoadedMetadata={() => {
               // Optional: Trigger a check when metadata loads if monitoring
            }}
          />
          <canvas ref={canvasRef} className="hidden" />
          
          {!isMonitoring && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400">
              <span className="bg-black/50 px-3 py-1 rounded-md text-sm">摄像头已暂停</span>
            </div>
          )}
          
          {isProcessing && isMonitoring && (
            <div className="absolute top-2 right-2 flex items-center gap-2 bg-black/50 px-2 py-1 rounded-full z-10">
              <span className="text-xs text-white">分析中...</span>
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-ping"></div>
            </div>
          )}
        </>
      )}
    </div>
  );
});

WebcamMonitor.displayName = 'WebcamMonitor';