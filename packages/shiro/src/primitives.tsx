import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from "react";

type ContainerElement = "div" | "section" | "header" | "main" | "aside" | "nav";
type ContainerTone = "panel" | "subtle" | "transparent";
type RowSlot = "primary" | "alert" | "warning" | "secondary" | "actions";
type RowBreakpoint = "sm" | "md" | "lg";
type RowDensity = "compact" | "regular";
type RowStyle = "primary" | "secondary" | "muted" | "contrast" | "warning" | "alert" | "title" | "group-header";
type RowTitleAs = "h1" | "h2" | "h3";
type ClickableRowStyle = "primary" | "secondary" | "muted" | "contrast";
type ButtonTone = "default" | "danger";

const joinClasses = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((part): part is string => Boolean(part)).join(" ");

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  as?: ContainerElement;
  tone?: ContainerTone;
  bordered?: boolean;
  children: ReactNode;
}

interface ButtonBaseProps {
  children: ReactNode;
  className?: string | undefined;
  tone?: ButtonTone | undefined;
  title?: string | undefined;
  ariaLabel?: string | undefined;
}

type ButtonAsActionProps = ButtonBaseProps & {
  url?: undefined;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
};

type ButtonAsLinkProps = ButtonBaseProps & {
  url: string;
  onClick?: (() => void) | undefined;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"] | undefined;
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>["rel"] | undefined;
  disabled?: boolean | undefined;
};

export type ButtonProps = ButtonAsActionProps | ButtonAsLinkProps;

export function Button({ children, className, tone = "default", title, ariaLabel, ...rest }: ButtonProps) {
  const toneClass = tone === "danger" ? "btn-danger" : undefined;
  const buttonClass = joinClasses("btn", "ui-button", toneClass, className);

  if ("url" in rest && rest.url) {
    const { url, onClick, target, rel, disabled = false } = rest;
    const handleClick = onClick
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onClick();
        }
      : undefined;

    return (
      <a
        className={buttonClass}
        href={disabled ? undefined : url}
        onClick={handleClick}
        target={target}
        rel={rel}
        title={title}
        aria-label={ariaLabel}
        aria-disabled={disabled ? "true" : undefined}
      >
        {children}
      </a>
    );
  }

  const { onClick, disabled = false } = rest;
  return (
    <button className={buttonClass} type="button" onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Container({
  as = "div",
  tone = "transparent",
  bordered = false,
  className,
  children,
  ...rest
}: ContainerProps) {
  const Element = as;
  return (
    <Element className={joinClasses("ui-container", `ui-container-${tone}`, bordered && "ui-container-bordered", className)} {...rest}>
      {children}
    </Element>
  );
}

export interface PanelProps extends Omit<ContainerProps, "tone" | "bordered"> {}

export function Panel({ as = "section", ...rest }: PanelProps) {
  return <Container as={as} tone="panel" bordered {...rest} />;
}

export function SubtlePanel({ as = "section", ...rest }: PanelProps) {
  return <Container as={as} tone="subtle" bordered {...rest} />;
}

export interface RowStackProps extends Omit<ContainerProps, "children"> {
  children: ReactNode;
}

export function RowStack({ className, children, ...rest }: RowStackProps) {
  return (
    <Container className={joinClasses("ui-row-stack", className)} {...rest}>
      {children}
    </Container>
  );
}

export interface RowAction {
  icon: ReactNode;
  callbackFunc?: (() => void) | undefined;
  url?: string | undefined;
  title?: string | undefined;
  ariaLabel?: string | undefined;
  tone?: ButtonTone | undefined;
  disabled?: boolean | undefined;
}

type RowWithSecondary = {
  secondaryText?: ReactNode;
  actions?: never;
};

type RowWithActions = {
  secondaryText?: never;
  actions: RowAction[];
};

type RowWithNeither = {
  secondaryText?: undefined;
  actions?: undefined;
};

type RowTitleStyleProps = {
  style: "title";
  as?: RowTitleAs | undefined;
};

type RowGroupHeaderStyleProps = {
  style: "group-header";
  as?: "h3" | undefined;
};

type RowNonTitleStyleProps = {
  style?: Exclude<RowStyle, "title" | "group-header"> | undefined;
  as?: undefined;
};

type RowBaseProps = Omit<ContainerProps, "children" | "as" | "style"> & {
  primary: ReactNode;
  alertText?: ReactNode;
  warningText?: ReactNode;
  density?: RowDensity;
  collapseAt?: RowBreakpoint | "none" | undefined;
  hideSlotsSm?: RowSlot[] | undefined;
  hideSlotsMd?: RowSlot[] | undefined;
  hideSlotsLg?: RowSlot[] | undefined;
};

export type RowProps =
  RowBaseProps &
  (RowWithSecondary | RowWithActions | RowWithNeither) &
  (RowTitleStyleProps | RowGroupHeaderStyleProps | RowNonTitleStyleProps);

export function Row({
  primary,
  alertText,
  warningText,
  secondaryText,
  actions,
  density = "regular",
  collapseAt = "sm",
  hideSlotsSm,
  hideSlotsMd,
  hideSlotsLg,
  style = "primary",
  as,
  className,
  ...rest
}: RowProps) {
  const hasAlert = alertText !== undefined && alertText !== null;
  const hasWarning = warningText !== undefined && warningText !== null;
  const hasSecondary = secondaryText !== undefined && secondaryText !== null;
  const hasActions = Array.isArray(actions) && actions.length > 0;
  const hideClasses = [
    ...(hideSlotsSm ?? []).map((slot) => `ui-row-hide-sm-${slot}`),
    ...(hideSlotsMd ?? []).map((slot) => `ui-row-hide-md-${slot}`),
    ...(hideSlotsLg ?? []).map((slot) => `ui-row-hide-lg-${slot}`),
  ];

  const PrimaryElement = style === "title" ? (as ?? "h2") : style === "group-header" ? (as ?? "h3") : "div";

  return (
    <Container
      {...rest}
      className={joinClasses(
        "ui-row",
        `ui-row-${density}`,
        collapseAt !== "none" && `ui-row-collapse-${collapseAt}`,
        hasAlert && "ui-row-has-alert",
        hasWarning && "ui-row-has-warning",
        hasSecondary && "ui-row-has-secondary",
        hasActions && "ui-row-has-actions",
        ...hideClasses,
        className
      )}
    >
      <div className="ui-row-primary">
        <PrimaryElement className={joinClasses("ui-row-primary-content", `ui-row-style-${style}`)}>{primary}</PrimaryElement>
        {alertText ? <span className="ui-row-primary-alert">{alertText}</span> : null}
        {warningText ? <span className="ui-row-primary-warning">{warningText}</span> : null}
      </div>
      {hasSecondary ? <div className="ui-row-secondary">{secondaryText}</div> : null}
      {hasActions ? (
        <div className="ui-row-actions">
          {actions.map((action, index) => (
            <Button
              key={`${index}-${action.title ?? "action"}`}
              tone={action.tone}
              onClick={action.callbackFunc}
              url={action.url}
              title={action.title}
              ariaLabel={action.ariaLabel}
              disabled={action.disabled}
            >
              {action.icon}
            </Button>
          ))}
        </div>
      ) : null}
    </Container>
  );
}

export interface ClickableRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  active?: boolean;
  rowStyle?: ClickableRowStyle;
}

export function ClickableRow({ active = false, rowStyle = "secondary", className, children, ...rest }: ClickableRowProps) {
  return (
    <button className={joinClasses("clickable-row-button", active && "is-active", className)} {...rest}>
      <Row className="clickable-row" density="compact" style={rowStyle} primary={children} collapseAt="none" />
    </button>
  );
}
