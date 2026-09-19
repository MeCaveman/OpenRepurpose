import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { controlClassName } from './control-styles';
import { cx } from './utils';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = 'text', ...props },
  ref,
) {
  return (
    <input
      {...props}
      className={cx('h-[var(--or-field-height)]', controlClassName, className)}
      ref={ref}
      type={type}
    />
  );
});
