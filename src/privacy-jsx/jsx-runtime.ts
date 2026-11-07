import { jsx as originalJsx, jsxs as originalJsxs } from 'react/jsx-runtime'
import { privateProps } from './mask'
export { Fragment } from 'react/jsx-runtime'
export type { JSX } from 'react/jsx-runtime'

export const jsx: typeof originalJsx = (type, props, key) => originalJsx(type, privateProps(type, props), key)
export const jsxs: typeof originalJsxs = (type, props, key) => originalJsxs(type, privateProps(type, props), key)
