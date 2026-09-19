import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';

import { controlClassName } from './control-styles';
import { cx } from './utils';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      {...props}
      className={cx(
        'min-h-[var(--or-textarea-min-height)] resize-y py-[var(--or-space-2)]',
        controlClassName,
        className,
      )}
      ref={ref}
    />
  );
});
