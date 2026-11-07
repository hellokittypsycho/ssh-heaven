import { jsxDEV as original } from 'react/jsx-dev-runtime'
import { privateProps } from './mask'
export { Fragment } from 'react/jsx-dev-runtime'
export type { JSX } from 'react/jsx-dev-runtime'

export const jsxDEV: typeof original = (type, props, key, isStaticChildren, source, self) => original(type, privateProps(type, props), key, isStaticChildren, source, self)
