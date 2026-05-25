function hueFromName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

function initialsFromName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface UserAvatarProps {
  name: string;
  className?: string;
  title?: string;
}

/** 本地首字母头像，不依赖外网 ui-avatars.com */
export const UserAvatar: React.FC<UserAvatarProps> = ({ name, className = '', title }) => {
  const initials = initialsFromName(name);
  const hue = hueFromName(name);

  return (
    <div
      role="img"
      aria-label={title ?? name}
      title={title ?? name}
      className={`flex shrink-0 items-center justify-center rounded-full border border-gray-200 text-xs font-semibold text-white ${className}`}
      style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
    >
      {initials}
    </div>
  );
};
