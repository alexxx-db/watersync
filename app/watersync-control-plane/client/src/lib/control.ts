import { useOutletContext } from 'react-router';
import type { Context } from '../types';

/** The selected location and refresh controls that Layout passes to every page. */
export const useControl = () => useOutletContext<Context>();
