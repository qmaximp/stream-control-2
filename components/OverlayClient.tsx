'use client'

import type { StreamElement, SyncState } from '@/lib/types'
import { toEmbedUrl } from '@/lib/embed'
import { useEffect, useState } from 'react'
import { io as ioInit } from 'socket.io-client'

export default function OverlayClient() {
	const [state, setState] = useState<SyncState>({
		elements: [],
		canvasW: 1920,
		canvasH: 1080,
	})
	const [, force] = useState(0)
	const [scale, setScale] = useState(1)

	useEffect(() => {
		const socket = ioInit({ transports: ['websocket', 'polling'] })
		socket.on('state:init', (s: SyncState) => setState(s))
		socket.on('element:added', (el: StreamElement) =>
			setState(p => ({ ...p, elements: [...p.elements, el] })),
		)
		socket.on('element:updated', (el: StreamElement) =>
			setState(p => ({
				...p,
				elements: p.elements.map(e => (e.id === el.id ? { ...e, ...el } : e)),
			})),
		)
		socket.on('element:moved', (d: { id: string; x: number; y: number }) =>
			setState(p => ({
				...p,
				elements: p.elements.map(e =>
					e.id === d.id ? { ...e, x: d.x, y: d.y } : e,
				),
			})),
		)
		socket.on(
			'element:resized',
			(d: { id: string; x?: number; y?: number; width: number; height: number }) =>
				setState(p => ({
					...p,
					elements: p.elements.map(e =>
						e.id === d.id ? { ...e, x: d.x ?? e.x, y: d.y ?? e.y, width: d.width, height: d.height } : e,
					),
				})),
		)
		socket.on('element:deleted', (id: string) =>
			setState(p => ({ ...p, elements: p.elements.filter(e => e.id !== id) })),
		)
		socket.on('canvas:resize', (dims: { w: number; h: number }) =>
			setState(p => ({ ...p, canvasW: dims.w, canvasH: dims.h })),
		)
		return () => {
			socket.disconnect()
		}
	}, [])

	useEffect(() => {
		const i = setInterval(() => force(x => x + 1), 250)
		return () => clearInterval(i)
	}, [])

	useEffect(() => {
		const update = () => {
			const sw = window.innerWidth / state.canvasW
			const sh = window.innerHeight / state.canvasH
			setScale(Math.min(sw, sh))
		}
		update()
		window.addEventListener('resize', update)
		return () => window.removeEventListener('resize', update)
	}, [state.canvasW, state.canvasH])

	const sorted = [...state.elements].sort(
		(a, b) => (a.zIndex || 0) - (b.zIndex || 0),
	)

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				overflow: 'hidden',
				background: 'transparent',
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: state.canvasW,
					height: state.canvasH,
					transform: `scale(${scale})`,
					transformOrigin: 'top left',
					overflow: 'hidden',
				}}
			>
				{sorted.map(el =>
					el.visible || el.alwaysLoaded ? (
						<OverlayElement key={el.id} el={el} />
					) : null,
				)}
			</div>
		</div>
	)
}

function OverlayElement({ el }: { el: StreamElement }) {
	const [, force] = useState(0)

	useEffect(() => {
		if (el.type !== 'timer' || !el.isRunning) return
		const i = setInterval(() => force(x => x + 1), 100)
		return () => clearInterval(i)
	}, [el.type, el.isRunning])

	const style: React.CSSProperties = {
		position: 'absolute',
		left: el.x,
		top: el.y,
		width: el.width,
		height: el.height,
		zIndex: el.zIndex,
		visibility: el.visible ? 'visible' : 'hidden',
		opacity: el.opacity ?? 1,
	}

	if (el.type === 'image' || el.type === 'gif')
		return (
			<div style={style}>
				<img
					src={el.src}
					alt=''
					style={{ width: '100%', height: '100%', objectFit: 'fill' }}
					draggable={false}
				/>
			</div>
		)
	if (el.type === 'video')
		return (
			<div style={style}>
				<video
					src={el.src}
					style={{ width: '100%', height: '100%', objectFit: 'fill' }}
					autoPlay
					loop
					muted
					playsInline
				/>
			</div>
		)
	if (el.type === 'iframe')
		return (
			<div style={style}>
				<iframe
					src={toEmbedUrl(el.src || '')}
					title='embed'
					style={{ width: '100%', height: '100%', border: 'none' }}
					allow='autoplay; encrypted-media; picture-in-picture; fullscreen'
					allowFullScreen
				/>
			</div>
		)
	if (el.type === 'text')
		return (
			<div
				style={{
					...style,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					fontSize: el.fontSize,
					color: el.color,
					fontWeight: el.fontWeight,
					background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
					textAlign: 'center',
					overflow: 'hidden',
					wordBreak: 'break-word',
				}}
			>
				{el.text}
			</div>
		)
	if (el.type === 'timer') {
		const elapsedMs =
			el.isRunning && el.startTime
				? Date.now() - el.startTime
				: (el.elapsed || 0)
		const elapsedSec = Math.floor(elapsedMs / 1000)
		const display =
			el.timerDirection === 'down' && el.duration
				? formatTime(Math.max(0, el.duration - elapsedSec))
				: formatTime(elapsedSec)
		return (
			<div
				style={{
					...style,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				{el.timerLabel && (
					<div
						style={{
							fontSize: (el.fontSize || 40) * 0.5,
							color: el.color,
							fontWeight: el.fontWeight,
							marginBottom: 4,
							background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
							padding: '2px 8px',
							borderRadius: 4,
						}}
					>
						{el.timerLabel}
					</div>
				)}
				<div
					style={{
						fontSize: el.fontSize,
						color: el.color,
						fontWeight: el.fontWeight,
						background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
						padding: '4px 12px',
						borderRadius: 6,
						fontFamily: 'monospace',
						letterSpacing: 2,
					}}
				>
					{display}
				</div>
			</div>
		)
	}
	return null
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60)
	const s = seconds % 60
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
