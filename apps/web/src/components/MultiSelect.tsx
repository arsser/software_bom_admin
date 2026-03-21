import React, { useState, useRef, useEffect } from 'react';
import { X, ChevronDown, Check } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchable?: boolean;
  maxHeight?: string;
  showSelectAll?: boolean;
  widthOffset?: number; // 宽度偏移量（px），正数增加宽度，负数减少宽度
}

export const MultiSelect: React.FC<MultiSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = '请选择...',
  searchable = true,
  maxHeight = '200px',
  showSelectAll = true,
  widthOffset = 100, // 默认增加 100px
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉框
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);


  // 获取选中的标签
  const selectedLabels = options
    .filter(option => value.includes(option.value))
    .map(option => option.label);

  // 检查是否全选（基于过滤后的选项）
  const filteredOptions = options.filter(option =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const allSelected = filteredOptions.length > 0 && filteredOptions.every(option => value.includes(option.value));

  // 切换选中状态
  const toggleOption = (optionValue: string) => {
    if (value.includes(optionValue)) {
      onChange(value.filter(v => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  };

  // 全选/取消全选（基于过滤后的选项）
  const toggleSelectAll = () => {
    if (allSelected) {
      // 取消全选：移除所有过滤后选项的值
      const filteredValues = filteredOptions.map(opt => opt.value);
      onChange(value.filter(v => !filteredValues.includes(v)));
    } else {
      // 全选：添加所有过滤后选项的值
      const filteredValues = filteredOptions.map(opt => opt.value);
      const newValues = [...new Set([...value, ...filteredValues])];
      onChange(newValues);
    }
  };

  // 清除所有选中项
  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  // 移除选中项
  const removeOption = (optionValue: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter(v => v !== optionValue));
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {/* 输入框 */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="w-full min-h-[38px] px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white cursor-pointer hover:border-gray-300 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-colors"
      >
        <div className="flex flex-wrap gap-1.5 items-center pr-6">
          {/* 选中的标签 */}
          {selectedLabels.length > 0 ? (
            selectedLabels.map((label) => {
              const optionValue = options.find(opt => opt.label === label)?.value || '';
              return (
                <span
                  key={optionValue}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-md border border-blue-200"
                >
                  <span className="max-w-[120px] truncate">{label}</span>
                  <button
                    onClick={(e) => removeOption(optionValue, e)}
                    className="hover:bg-blue-100 rounded p-0.5 transition-colors"
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })
          ) : (
            <span className="text-sm text-gray-400">{placeholder}</span>
          )}
        </div>
        <ChevronDown
          size={16}
          className={`absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </div>

      {/* 下拉列表 */}
      {isOpen && (
        <div
          className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
          style={{ 
            width: `calc(100% + ${widthOffset}px)`,
            minWidth: `calc(100% + ${widthOffset}px)`,
            maxHeight: (() => {
              // 解析 maxHeight，增加 100px
              if (typeof maxHeight === 'string') {
                const heightValue = parseInt(maxHeight.replace('px', '').trim());
                return `${heightValue + 100}px`;
              }
              return `${parseInt(String(maxHeight)) + 100}px`;
            })()
          }}
        >
          {/* 搜索框 */}
          {searchable && (
            <div className="p-2 border-b border-gray-100">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="搜索..."
                className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
          )}

          {/* 全选/清除按钮 */}
          {showSelectAll && filteredOptions.length > 0 && (
            <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSelectAll();
                }}
                className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
              {value.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    clearAll(e);
                  }}
                  className="text-xs text-red-600 hover:text-red-700 hover:underline"
                >
                  清除全部
                </button>
              )}
            </div>
          )}

          {/* 选项列表 */}
          <div className="overflow-y-auto" style={{ maxHeight: `calc(${maxHeight} - ${searchable ? '60px' : '0px'} - ${showSelectAll && filteredOptions.length > 0 ? '40px' : '0px'})` }}>
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const isSelected = value.includes(option.value);
                return (
                  <div
                    key={option.value}
                    onClick={() => toggleOption(option.value)}
                    className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${
                      isSelected ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className={`flex-shrink-0 w-4 h-4 border-2 rounded flex items-center justify-center ${
                      isSelected
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-gray-300'
                    }`}>
                      {isSelected && <Check size={12} className="text-white" />}
                    </div>
                    <span className={`text-xs flex-1 ${
                      isSelected ? 'text-blue-700 font-medium' : 'text-gray-700'
                    }`}>
                      {option.label}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-xs text-gray-400 text-center">
                没有找到选项
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

