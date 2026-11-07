import { reportWallpaperLoadError, useReducedMotion, useWallpaper, wallpaperSource } from '../wallpaper'
import './wallpaper-layer.css'

/** A decorative background only. Text and controls keep their own opacity. */
export function WallpaperLayer() {
  const wallpaper = useWallpaper()
  const reducedMotion = useReducedMotion()
  const source = wallpaperSource(wallpaper, reducedMotion)
  if (!wallpaper.enabled || !source) return null
  const playing = wallpaper.kind === 'gif' && wallpaper.animate && !reducedMotion
  return <div className="wallpaper-layer" aria-hidden="true" data-animated={String(playing)} data-fit={wallpaper.fit}>
    <img src={source} alt="" draggable={false} decoding="async" onError={() => reportWallpaperLoadError(source)} style={{ opacity: wallpaper.opacity, filter: wallpaper.blur ? `blur(${wallpaper.blur}px)` : undefined, objectFit: wallpaper.fit, inset: -wallpaper.blur * 2, width: `calc(100% + ${wallpaper.blur * 4}px)`, height: `calc(100% + ${wallpaper.blur * 4}px)` }} />
  </div>
}
