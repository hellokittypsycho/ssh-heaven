import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ImagePlus, LoaderCircle, Moon, Palette, Sun, Trash2 } from 'lucide-react'
import type { WallpaperPreferences } from '../../shared/types'
import { THEME_PRESETS, useTheme } from '../theme'
import { chooseWallpaper, clearWallpaper, loadWallpaper, reportWallpaperLoadError, setWallpaperPreferences, useReducedMotion, useWallpaper, wallpaperSource } from '../wallpaper'
import { Modal, errorMessage } from './Modal'
import './appearance.css'

export function Appearance({ onClose }: { onClose: () => void }) {
  const { preset, setTheme } = useTheme()
  const wallpaper = useWallpaper()
  const reducedMotion = useReducedMotion()
  const [loading, setLoading] = useState(true)
  const [assetBusy, setAssetBusy] = useState(false)
  const [saving, setSaving] = useState(0)
  const [error, setError] = useState('')
  const [previewFailed, setPreviewFailed] = useState(false)
  const busyRef = useRef(false)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  const source = wallpaperSource(wallpaper, reducedMotion)
  const hasAsset = !!wallpaper.assetUrl
  useEffect(() => {
    let active = true
    void loadWallpaper().catch((cause) => { if (active) setError(errorMessage(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => { setPreviewFailed(false) }, [source])
  async function changeAsset(remove: boolean) {
    if (busyRef.current) return
    busyRef.current = true; setAssetBusy(true); setError('')
    try { await (remove ? clearWallpaper() : chooseWallpaper()) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { busyRef.current = false; setAssetBusy(false) }
  }
  function changePreferences(patch: Partial<WallpaperPreferences>) {
    setError(''); setSaving((count) => count + 1)
    void setWallpaperPreferences(patch).catch((cause) => setError(errorMessage(cause))).finally(() => setSaving((count) => count - 1))
  }
  return <Modal title="Appearance" onClose={close} className="appearance-modal">
    <div className="appearance-body">
    <div className="appearance-intro"><span><Palette size={22} /></span><div><h3>Make room for your style.</h3><p>{THEME_PRESETS.length} palettes. One workspace. Your choice is saved on this device.</p></div></div>
    <div className="appearance-section-label"><span>COLOR PRESETS</span><span>Applies instantly</span></div>
    <fieldset className="appearance-grid"><legend className="appearance-sr-only">Color presets</legend>{THEME_PRESETS.map((option) => <label key={option.id} className={`appearance-card ${preset.id === option.id ? 'selected' : ''}`}>
      <input type="radio" name="theme-preset" value={option.id} checked={preset.id === option.id} aria-label={option.name} onChange={() => setTheme(option.id)} />
      <div className="appearance-preview" aria-hidden="true" style={{ background: option.colors.bg, borderColor: option.colors.border }}>
        <div className="appearance-mini-sidebar" style={{ background: option.colors.sidebar, borderColor: option.colors.border }}><i style={{ background: option.colors.accent }} /><b style={{ background: option.colors['text-muted'] }} /><b style={{ background: option.colors['text-muted'] }} /><b style={{ background: option.colors['text-muted'] }} /></div>
        <div className="appearance-mini-main"><span style={{ background: option.colors['text-secondary'] }} /><div style={{ background: option.colors.surface, borderColor: option.colors.border }}><i style={{ background: option.colors.accent }} /><b style={{ background: option.colors['text-muted'] }} /><b style={{ background: option.colors['text-muted'] }} /></div><code style={{ color: option.colors.accent }}>&gt;_</code></div>
        {preset.id === option.id && <span className="appearance-selected" style={{ background: option.colors.accent, color: option.colors['on-accent'] }}><Check size={12} /></span>}
      </div>
      <div className="appearance-card-caption"><strong>{option.name}</strong>{option.appearance === 'light' ? <Sun size={13} /> : <Moon size={13} />}</div>
      <small>{option.description}</small>
    </label>)}</fieldset>
    <section className="appearance-wallpaper" aria-label="Wallpaper settings">
      <div className="appearance-wallpaper-heading"><div><h3>Wallpaper</h3><p>An image or GIF from this device, kept as a local copy.</p></div><span className="appearance-wallpaper-state">{hasAsset && wallpaper.enabled ? 'Enabled' : 'Off'}</span></div>
      {(error || wallpaper.error) && <div className="form-error" role="alert">{error || wallpaper.error}</div>}
      <div className="appearance-wallpaper-layout">
        <div className="appearance-wallpaper-visual">
          <div className="appearance-wallpaper-preview" aria-label="Wallpaper preview" data-fit={wallpaper.fit}>
            {source && !previewFailed && <img src={source} alt="" aria-hidden="true" draggable={false} onError={() => { setPreviewFailed(true); reportWallpaperLoadError(source) }} style={{ opacity: wallpaper.opacity, filter: wallpaper.blur ? `blur(${wallpaper.blur}px)` : undefined, objectFit: wallpaper.fit }} />}
            <div className="appearance-wallpaper-preview-content"><span><i />Your workspace</span><code>&gt; Ready when you are.<b>▌</b></code></div>
            {!hasAsset && <span className="appearance-wallpaper-preview-empty"><ImagePlus size={23} />Add a personal touch</span>}
          </div>
          <div className="appearance-wallpaper-file"><strong>{loading ? 'Checking wallpaper…' : wallpaper.name || 'No wallpaper selected'}</strong><small>{previewFailed ? 'Preview unavailable. Choose the file again.' : wallpaper.kind === 'gif' ? reducedMotion || !wallpaper.animate ? 'GIF · Still frame' : 'GIF · Animated' : hasAsset ? 'Local image' : 'PNG, JPEG, WebP, or GIF'}</small></div>
          <div className="appearance-wallpaper-actions"><button className="button secondary compact" disabled={loading || assetBusy} onClick={() => void changeAsset(false)} aria-label="Choose wallpaper">{assetBusy ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}{hasAsset ? 'Change wallpaper' : 'Choose wallpaper'}</button>{hasAsset && <button className="button secondary compact" disabled={assetBusy} onClick={() => void changeAsset(true)} aria-label="Remove wallpaper"><Trash2 size={14} />Remove</button>}</div>
        </div>
        <div className="appearance-wallpaper-controls">
          <label className="appearance-wallpaper-toggle"><span><strong>Enable wallpaper</strong><small>Visible on Home and behind your terminal.</small></span><input type="checkbox" aria-label="Enable wallpaper" checked={wallpaper.enabled && hasAsset} disabled={!hasAsset || assetBusy} onChange={(event) => changePreferences({ enabled: event.target.checked })} /></label>
          <div className="appearance-wallpaper-range"><label htmlFor="wallpaper-opacity">Opacity <output>{Math.round(wallpaper.opacity * 100)}%</output></label><input id="wallpaper-opacity" aria-label="Wallpaper opacity" type="range" min="0" max="100" step="1" value={Math.round(wallpaper.opacity * 100)} disabled={!hasAsset || assetBusy} onChange={(event) => changePreferences({ opacity: Number(event.target.value) / 100 })} /><small>Only the background fades. Text stays fully opaque.</small></div>
          <div className="appearance-wallpaper-range"><label htmlFor="wallpaper-blur">Blur <output>{wallpaper.blur}px</output></label><input id="wallpaper-blur" aria-label="Wallpaper blur" type="range" min="0" max="20" step="1" value={wallpaper.blur} disabled={!hasAsset || assetBusy} onChange={(event) => changePreferences({ blur: Number(event.target.value) })} /></div>
          <label className="appearance-wallpaper-fit">Wallpaper fit<select aria-label="Wallpaper fit" value={wallpaper.fit} disabled={!hasAsset || assetBusy} onChange={(event) => changePreferences({ fit: event.target.value as WallpaperPreferences['fit'] })}><option value="cover">Cover · fill the workspace</option><option value="contain">Contain · show the full image</option></select></label>
          {wallpaper.kind === 'gif' && <div><label className="appearance-wallpaper-toggle animation-toggle"><span><strong>Animate GIF</strong><small>{reducedMotion ? 'Your system requests reduced motion. A still frame is shown.' : 'Turn off to use a still frame.'}</small></span><input type="checkbox" aria-label="Animate GIF" checked={wallpaper.animate} disabled={assetBusy || reducedMotion} onChange={(event) => changePreferences({ animate: event.target.checked })} /></label></div>}
        </div>
      </div>
    </section>
    </div>
    <div className="appearance-footer"><div><span className="appearance-current-dot" /><span><strong>{preset.name}</strong> · {preset.appearance === 'dark' ? 'Dark' : 'Light'} appearance</span>{saving > 0 && <span className="appearance-saving" role="status">Saving…</span>}</div><button className="button primary" disabled={assetBusy} onClick={close}>Done</button></div>
  </Modal>
}
