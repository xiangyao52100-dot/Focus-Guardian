import React from 'react';
import { StudyStatus, AnalysisResult } from '../types';

interface StatusOverlayProps {
  result: AnalysisResult;
}

export const StatusOverlay: React.FC<StatusOverlayProps> = ({ result }) => {
  const { status, reason } = result;

  if (status === StudyStatus.IDLE) return null;

  // Reward State
  if (status === StudyStatus.STUDYING) {
    return (
      <div className="fixed inset-0 pointer-events-none z-50 flex items-end justify-end p-4 sm:p-8 overflow-hidden">
        {/* Ambient Glow - 全屏背景特效保持不变 */}
        <div className="absolute inset-0 bg-green-500/10 transition-colors duration-1000"></div>
        
        {/* Floating Particles (Simulated with CSS) */}
        <div className="absolute inset-0">
           <div className="absolute top-1/4 left-1/4 w-4 h-4 bg-yellow-300 rounded-full animate-bounce opacity-75"></div>
           <div className="absolute top-1/3 right-1/4 w-6 h-6 bg-green-300 rounded-full animate-pulse opacity-60"></div>
           <div className="absolute bottom-1/4 left-1/2 w-3 h-3 bg-blue-300 rounded-full animate-ping opacity-80"></div>
        </div>

        {/* Card - 移动到右下角的小卡片 */}
        <div className="relative bg-white/90 backdrop-blur-md border border-green-200 text-green-800 p-6 rounded-2xl shadow-2xl transform transition-all duration-500 scale-100 animate-fade-in-up w-80 text-center sm:mr-4 sm:mb-4">
          <div className="text-5xl mb-3">🌟</div>
          <h2 className="text-2xl font-bold mb-1">专心致志!</h2>
          <p className="text-base font-medium">{reason || "保持这个状态，你做得很好！"}</p>
          <div className="mt-4 w-full bg-green-200 h-2 rounded-full overflow-hidden">
             <div className="h-full bg-green-500 w-full animate-pulse"></div>
          </div>
        </div>
      </div>
    );
  }

  // Punishment/Warning State
  if (status === StudyStatus.DISTRACTED || status === StudyStatus.ABSENT) {
    return (
      <div className="fixed inset-0 pointer-events-none z-50 flex items-end justify-end p-4 sm:p-8">
        {/* Alarm Background - 全屏背景特效保持不变 */}
        <div className="absolute inset-0 bg-red-600/30 animate-pulse"></div>
        
        {/* Card - 移动到右下角的小卡片 */}
        <div className="relative bg-red-50 backdrop-blur-md border-4 border-red-500 text-red-900 p-6 rounded-2xl shadow-2xl w-80 text-center animate-[wiggle_0.3s_ease-in-out_infinite] sm:mr-4 sm:mb-4">
          <div className="text-5xl mb-3">🚨</div>
          <h2 className="text-2xl font-extrabold mb-1 text-red-600 uppercase tracking-widest">警告</h2>
          <p className="text-lg font-bold">{reason || "放下手机，回到学习中！"}</p>
          
          <div className="mt-5 flex justify-center space-x-2">
            <span className="w-3 h-3 bg-red-600 rounded-full animate-bounce"></span>
            <span className="w-3 h-3 bg-red-600 rounded-full animate-bounce delay-100"></span>
            <span className="w-3 h-3 bg-red-600 rounded-full animate-bounce delay-200"></span>
          </div>
        </div>
      </div>
    );
  }

  return null;
};