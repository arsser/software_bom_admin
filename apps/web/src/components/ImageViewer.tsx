import React, { useState, useEffect } from 'react';
import { X, RotateCw, RotateCcw, ZoomIn, ZoomOut, Maximize2, Minimize2 } from 'lucide-react';

interface ImageViewerProps {
  imageUrl: string | null;
  onClose: () => void;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ imageUrl, onClose }) => {
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Reset state when image changes
  useEffect(() => {
    if (imageUrl) {
      setRotation(0);
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [imageUrl]);

  // Handle fullscreen change events
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!imageUrl) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isFullscreen) {
          document.exitFullscreen?.();
        } else {
          onClose();
        }
      } else if (e.key === 'r' || e.key === 'R') {
        if (e.shiftKey) {
          setRotation((prev) => (prev - 90 + 360) % 360);
        } else {
          setRotation((prev) => (prev + 90) % 360);
        }
      } else if (e.key === '+' || e.key === '=') {
        setScale((prev) => Math.min(prev + 0.25, 5));
      } else if (e.key === '-') {
        setScale((prev) => Math.max(prev - 0.25, 0.5));
      } else if (e.key === '0') {
        setScale(1);
        setRotation(0);
        setPosition({ x: 0, y: 0 });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [imageUrl, onClose, isFullscreen]);

  // Handle wheel events for zooming (non-passive to allow preventDefault)
  useEffect(() => {
    const elem = containerRef.current;
    if (!elem || !imageUrl) return;

    const handleWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setScale((prev) => Math.max(0.5, Math.min(5, prev + delta)));
    };

    elem.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => elem.removeEventListener('wheel', handleWheelNative);
  }, [imageUrl]);

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleRotateCounterClockwise = () => {
    setRotation((prev) => (prev - 90 + 360) % 360);
  };

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.25, 5));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.25, 0.5));
  };

  const handleReset = () => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  };

  const handleFullscreen = () => {
    if (!isFullscreen) {
      const elem = containerRef.current;
      if (!elem) return;

      if (elem.requestFullscreen) {
        elem.requestFullscreen();
      } else if ((elem as any).webkitRequestFullscreen) {
        (elem as any).webkitRequestFullscreen();
      } else if ((elem as any).msRequestFullscreen) {
        (elem as any).msRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };



  if (!imageUrl) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
      onClick={onClose}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 text-white hover:bg-white/20 rounded-lg transition-colors z-10"
        title="关闭 (Esc)"
      >
        <X size={24} />
      </button>

      {/* Controls */}
      <div className="absolute top-4 left-4 flex gap-2 z-10">
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleRotateCounterClockwise();
          }}
          className="p-2 text-white hover:bg-white/20 rounded-lg transition-colors"
          title="逆时针旋转 90° (Shift+R)"
        >
          <RotateCcw size={20} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleRotate();
          }}
          className="p-2 text-white hover:bg-white/20 rounded-lg transition-colors"
          title="顺时针旋转 90° (R)"
        >
          <RotateCw size={20} />
        </button>
        <div className="w-px bg-white/30 mx-1" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleZoomOut();
          }}
          className="p-2 text-white hover:bg-white/20 rounded-lg transition-colors"
          title="缩小 (-)"
        >
          <ZoomOut size={20} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleZoomIn();
          }}
          className="p-2 text-white hover:bg-white/20 rounded-lg transition-colors"
          title="放大 (+)"
        >
          <ZoomIn size={20} />
        </button>
        <div className="w-px bg-white/30 mx-1" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleReset();
          }}
          className="px-3 py-2 text-white hover:bg-white/20 rounded-lg transition-colors text-sm flex items-center gap-2"
          title="重置 (0)"
        >
          重置
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleFullscreen();
          }}
          className="px-3 py-2 text-white hover:bg-white/20 rounded-lg transition-colors text-sm flex items-center gap-2"
          title={isFullscreen ? '退出全屏' : '全屏'}
        >
          {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          <span>{isFullscreen ? '退出全屏' : '全屏'}</span>
        </button>
      </div>

      {/* Image */}
      <div
        className={`relative max-w-[90vw] max-h-[90vh] ${scale > 1 ? 'cursor-move' : 'cursor-default'}`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        style={{
          transform: `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        <img
          src={imageUrl}
          alt="查看大图"
          className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
          draggable={false}
        />
      </div>

      {/* Info */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-xs z-10 bg-black/40 px-3 py-1.5 rounded-full">
        缩放: {Math.round(scale * 100)}% | 旋转: {rotation}° | 滚轮缩放，拖拽移动
      </div>
    </div>
  );
};
