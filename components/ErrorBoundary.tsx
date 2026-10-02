'use client'

import React from 'react'

// Ловит ошибки рендера интерфейса и показывает кнопку «Обновить» вместо мёртвого
// экрана «Application error» (частый случай после деплоя — устаревшие чанки в кэше)
export default class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null }

	static getDerivedStateFromError(error: Error) {
		return { error }
	}

	render() {
		if (this.state.error) {
			return (
				<div className='min-h-[100dvh] bg-bg flex flex-col items-center justify-center text-center px-4'>
					<div className='text-5xl mb-4'>💥</div>
					<h1 className='text-lg font-semibold text-white mb-2'>
						Что-то сломалось
					</h1>
					<p className='text-sm text-gray-500 max-w-sm mb-6'>
						Произошла ошибка в интерфейсе. Обычно помогает обновление страницы.
					</p>
					<button
						onClick={() => location.reload()}
						className='px-6 py-3 rounded-lg bg-accent hover:bg-violet-700 text-white text-sm transition-colors'
					>
						Обновить страницу
					</button>
				</div>
			)
		}
		return this.props.children
	}
}
