/**
 * @deepseek-ai/dsh-client-ui-primitives 的本地类型桩。
 * 该包是平台模块（运行时由浏览器模块表提供，bundle 外部化），
 * 这里只声明本项目用到的图标组件的编译期形状。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  interface IconProps {
    size?: number
    className?: string
  }
  export const IconFolderClose16: (props?: IconProps) => JSX.Element
  export const IconFolderOpen16: (props?: IconProps) => JSX.Element
  export const IconTriangleRightFill14: (props?: IconProps) => JSX.Element
  export const IconRefreshOutline16: (props?: IconProps) => JSX.Element
  export const IconPanelLeftOutline16: (props?: IconProps) => JSX.Element
}
